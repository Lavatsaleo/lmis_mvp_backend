const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

// ---------- helpers ----------
async function getMyFacilityOrThrow(user) {
  if (!user?.facilityId) throw new Error("Your user has no facilityId assigned");

  const facility = await prisma.facility.findUnique({
    where: { id: user.facilityId },
  });

  if (!facility) throw new Error("Your assigned facilityId does not exist");
  return facility;
}

async function getBoxesOrThrow(boxUids) {
  const uids = [...new Set(boxUids.map((x) => String(x).trim()))];

  const boxes = await prisma.box.findMany({
    where: { boxUid: { in: uids } },
  });

  if (boxes.length !== uids.length) {
    const found = new Set(boxes.map((b) => b.boxUid));
    const missing = uids.filter((u) => !found.has(u));
    const err = new Error("Some boxUids not found");
    err.details = { missing, found: [...found] };
    throw err;
  }

  return boxes;
}

/**
 * POST /api/transactions/warehouse-receive
 * Body: { "boxUids": ["..."], "note": "optional" }
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 *
 * Only allowed if your user is assigned to a WAREHOUSE facility.
 * Only accepts boxes in CREATED state (idempotent if already in your warehouse).
 */
router.post(
  "/warehouse-receive",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { boxUids, note } = req.body || {};
      if (!Array.isArray(boxUids) || boxUids.length === 0) {
        return res.status(400).json({ message: "boxUids must be a non-empty array" });
      }

      const myFacility = await getMyFacilityOrThrow(req.user);
      if (myFacility.type !== "WAREHOUSE") {
        return res.status(403).json({ message: "You must be assigned to a WAREHOUSE to warehouse-receive" });
      }

      const boxes = await getBoxesOrThrow(boxUids);

      const updated = [];
      const skipped = [];

      await prisma.$transaction(async (tx) => {
        for (const b of boxes) {
          // Idempotent: already received in this warehouse
          if (b.status === "IN_WAREHOUSE" && b.currentFacilityId === myFacility.id) {
            skipped.push(b.boxUid);
            continue;
          }

          if (b.status !== "CREATED") {
            throw new Error(`Box ${b.boxUid} is not in CREATED state (current: ${b.status})`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: { status: "IN_WAREHOUSE", currentFacilityId: myFacility.id },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "WAREHOUSE_RECEIVE",
              performedByUserId: req.user.id,
              toFacilityId: myFacility.id,
              note: note || null,
            },
          });

          updated.push(b.boxUid);
        }
      });

      return res.json({
        message: "Warehouse receive complete",
        updatedCount: updated.length,
        skippedCount: skipped.length,
        updated,
        skipped,
      });
    } catch (err) {
      const details = err.details ? { details: err.details } : {};
      return res.status(400).json({ message: "Failed", error: String(err.message || err), ...details });
    }
  }
);

/**
 * POST /api/transactions/dispatch
 * Body: { "boxUids": [...], "toFacilityCode": "FAC-001", "note": "optional" }
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 *
 * From facility must be WAREHOUSE.
 * Boxes must be IN_WAREHOUSE and currently in your warehouse.
 * Sets status to IN_TRANSIT and clears currentFacilityId (so stock reduces in warehouse).
 */
router.post(
  "/dispatch",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { boxUids, toFacilityCode, note } = req.body || {};
      if (!Array.isArray(boxUids) || boxUids.length === 0) {
        return res.status(400).json({ message: "boxUids must be a non-empty array" });
      }
      if (!toFacilityCode) return res.status(400).json({ message: "toFacilityCode is required" });

      const fromFacility = await getMyFacilityOrThrow(req.user);
      if (fromFacility.type !== "WAREHOUSE") {
        return res.status(403).json({ message: "You must be assigned to a WAREHOUSE to dispatch" });
      }

      const toFacility = await prisma.facility.findUnique({
        where: { code: String(toFacilityCode).trim() },
      });
      if (!toFacility) return res.status(404).json({ message: "Destination facility not found" });
      if (toFacility.type !== "FACILITY") {
        return res.status(400).json({ message: "Destination must be a FACILITY (not a warehouse)" });
      }

      // Optional rule: warehouse can only dispatch to its child facilities (unless SUPER_ADMIN)
      if (req.user.role !== "SUPER_ADMIN") {
        if (!toFacility.warehouseId || toFacility.warehouseId !== fromFacility.id) {
          return res.status(403).json({
            message: "This facility is not under your warehouse (warehouseId mismatch)",
            yourWarehouse: fromFacility.code,
            toFacility: toFacility.code,
          });
        }
      }

      const boxes = await getBoxesOrThrow(boxUids);

      await prisma.$transaction(async (tx) => {
        for (const b of boxes) {
          if (b.status !== "IN_WAREHOUSE" || b.currentFacilityId !== fromFacility.id) {
            throw new Error(`Box ${b.boxUid} is not IN_WAREHOUSE in your warehouse`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: {
              status: "IN_TRANSIT",
              currentFacilityId: null, // important: remove from warehouse stock-on-hand
            },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "DISPATCH",
              performedByUserId: req.user.id,
              fromFacilityId: fromFacility.id,
              toFacilityId: toFacility.id,
              note: note || null,
            },
          });
        }
      });

      return res.json({
        message: "Dispatch complete",
        count: boxes.length,
        fromWarehouse: fromFacility.code,
        toFacility: toFacility.code,
      });
    } catch (err) {
      const details = err.details ? { details: err.details } : {};
      return res.status(400).json({ message: "Failed", error: String(err.message || err), ...details });
    }
  }
);

/**
 * POST /api/transactions/facility-receive
 * Body: { "boxUids": [...], "note": "optional" }
 * Roles: SUPER_ADMIN, FACILITY_OFFICER
 *
 * Facility must be FACILITY.
 * Box must be IN_TRANSIT.
 * Also validates: last DISPATCH must have been to THIS facility (duplicate-safe).
 */
router.post(
  "/facility-receive",
  requireAuth,
  requireRole("SUPER_ADMIN", "FACILITY_OFFICER"),
  async (req, res) => {
    try {
      const { boxUids, note } = req.body || {};
      if (!Array.isArray(boxUids) || boxUids.length === 0) {
        return res.status(400).json({ message: "boxUids must be a non-empty array" });
      }

      const myFacility = await getMyFacilityOrThrow(req.user);
      if (myFacility.type !== "FACILITY") {
        return res.status(403).json({ message: "You must be assigned to a FACILITY to facility-receive" });
      }

      const boxes = await getBoxesOrThrow(boxUids);
      const boxIds = boxes.map((b) => b.id);

      await prisma.$transaction(async (tx) => {
        // Pull latest DISPATCH events for these boxes (bulk), then map last dispatch per box
        const dispatchEvents = await tx.boxEvent.findMany({
          where: { boxId: { in: boxIds }, type: "DISPATCH" },
          orderBy: { createdAt: "desc" },
        });

        const lastDispatchByBoxId = new Map();
        for (const e of dispatchEvents) {
          if (!lastDispatchByBoxId.has(e.boxId)) lastDispatchByBoxId.set(e.boxId, e);
        }

        for (const b of boxes) {
          if (b.status !== "IN_TRANSIT") {
            throw new Error(`Box ${b.boxUid} is not IN_TRANSIT (current: ${b.status})`);
          }

          const lastDispatch = lastDispatchByBoxId.get(b.id);
          if (!lastDispatch) {
            throw new Error(`Box ${b.boxUid} has no DISPATCH record (cannot receive)`);
          }

          if (req.user.role !== "SUPER_ADMIN" && lastDispatch.toFacilityId !== myFacility.id) {
            throw new Error(`Box ${b.boxUid} was dispatched to a different facility (duplicate/route mismatch)`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: { status: "IN_FACILITY", currentFacilityId: myFacility.id },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "FACILITY_RECEIVE",
              performedByUserId: req.user.id,
              fromFacilityId: lastDispatch.fromFacilityId || null,
              toFacilityId: myFacility.id,
              note: note || null,
            },
          });
        }
      });

      return res.json({ message: "Facility receive complete", count: boxes.length, facility: myFacility.code });
    } catch (err) {
      const details = err.details ? { details: err.details } : {};
      return res.status(400).json({ message: "Failed", error: String(err.message || err), ...details });
    }
  }
);

/**
 * POST /api/transactions/dispense
 * Body: { "boxUid": "SPO-...-1", "note": "optional" }
 * Roles: SUPER_ADMIN, CLINICIAN
 *
 * Facility must be FACILITY.
 * Box must be IN_FACILITY and in your facility.
 */
router.post(
  "/dispense",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const { boxUid, note } = req.body || {};
      if (!boxUid) return res.status(400).json({ message: "boxUid is required" });

      const myFacility = await getMyFacilityOrThrow(req.user);
      if (myFacility.type !== "FACILITY") {
        return res.status(403).json({ message: "You must be assigned to a FACILITY to dispense" });
      }

      const box = await prisma.box.findUnique({ where: { boxUid: String(boxUid).trim() } });
      if (!box) return res.status(404).json({ message: "Box not found" });

      if (box.status !== "IN_FACILITY" || box.currentFacilityId !== myFacility.id) {
        return res.status(400).json({ message: "Box is not available in your facility to dispense" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.box.update({
          where: { id: box.id },
          data: { status: "DISPENSED" },
        });

        await tx.boxEvent.create({
          data: {
            boxId: box.id,
            type: "DISPENSE",
            performedByUserId: req.user.id,
            fromFacilityId: myFacility.id,
            note: note || null,
          },
        });
      });

      return res.json({ message: "Dispensed", boxUid: box.boxUid, facility: myFacility.code });
    } catch (err) {
      return res.status(400).json({ message: "Failed", error: String(err.message || err) });
    }
  }
);

module.exports = router;
