const express = require("express");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();
const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}

// POST /api/transactions/warehouse-receive
// Body: { "boxUids": ["SPO-...-00001", "..."], "note": "optional" }
router.post(
  "/warehouse-receive",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    const { boxUids, note } = req.body;
    if (!Array.isArray(boxUids) || boxUids.length === 0) {
      return res.status(400).json({ message: "boxUids must be a non-empty array" });
    }
    if (!req.user.facilityId) {
      return res.status(400).json({ message: "Your user has no facilityId assigned" });
    }

    try {
      const facilityId = req.user.facilityId;

      const boxes = await prisma.box.findMany({ where: { boxUid: { in: boxUids } } });
      if (boxes.length !== boxUids.length) {
        return res.status(404).json({
          message: "Some boxUids not found",
          found: boxes.map((b) => b.boxUid),
        });
      }

      await prisma.$transaction(async (tx) => {
        for (const b of boxes) {
          // Idempotent behavior: if already in this warehouse, skip
          if (b.status === "IN_WAREHOUSE" && b.currentFacilityId === facilityId) continue;

          if (b.status !== "CREATED") {
            throw new Error(`Box ${b.boxUid} is not in CREATED state (current: ${b.status})`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: { status: "IN_WAREHOUSE", currentFacilityId: facilityId },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "WAREHOUSE_RECEIVE",
              performedByUserId: req.user.id,
              toFacilityId: facilityId,
              note: note || null,
            },
          });
        }
      });

      return res.json({ message: "Warehouse receive complete", count: boxUids.length });
    } catch (err) {
      return res.status(400).json({ message: "Failed", error: String(err.message || err) });
    }
  }
);

// POST /api/transactions/dispatch
// Body: { "boxUids": [...], "toFacilityCode": "FAC-001", "note": "optional" }
router.post(
  "/dispatch",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    const { boxUids, toFacilityCode, note } = req.body;
    if (!Array.isArray(boxUids) || boxUids.length === 0) {
      return res.status(400).json({ message: "boxUids must be a non-empty array" });
    }
    if (!toFacilityCode) return res.status(400).json({ message: "toFacilityCode is required" });
    if (!req.user.facilityId) return res.status(400).json({ message: "Your user has no facilityId assigned" });

    try {
      const fromFacilityId = req.user.facilityId;
      const toFacility = await prisma.facility.findUnique({ where: { code: String(toFacilityCode) } });
      if (!toFacility) return res.status(404).json({ message: "Destination facility not found" });

      const boxes = await prisma.box.findMany({ where: { boxUid: { in: boxUids } } });

      await prisma.$transaction(async (tx) => {
        for (const b of boxes) {
          if (b.status !== "IN_WAREHOUSE" || b.currentFacilityId !== fromFacilityId) {
            throw new Error(`Box ${b.boxUid} is not IN_WAREHOUSE in your warehouse`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: { status: "IN_TRANSIT" },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "DISPATCH",
              performedByUserId: req.user.id,
              fromFacilityId,
              toFacilityId: toFacility.id,
              note: note || null,
            },
          });
        }
      });

      return res.json({ message: "Dispatch complete", count: boxUids.length, toFacility: toFacility.code });
    } catch (err) {
      return res.status(400).json({ message: "Failed", error: String(err.message || err) });
    }
  }
);

// POST /api/transactions/facility-receive
// Body: { "boxUids": [...], "note": "optional" }
router.post(
  "/facility-receive",
  requireAuth,
  requireRole("SUPER_ADMIN", "FACILITY_OFFICER"),
  async (req, res) => {
    const { boxUids, note } = req.body;
    if (!Array.isArray(boxUids) || boxUids.length === 0) {
      return res.status(400).json({ message: "boxUids must be a non-empty array" });
    }
    if (!req.user.facilityId) return res.status(400).json({ message: "Your user has no facilityId assigned" });

    try {
      const facilityId = req.user.facilityId;
      const boxes = await prisma.box.findMany({ where: { boxUid: { in: boxUids } } });

      await prisma.$transaction(async (tx) => {
        for (const b of boxes) {
          if (b.status !== "IN_TRANSIT") {
            throw new Error(`Box ${b.boxUid} is not IN_TRANSIT (current: ${b.status})`);
          }

          await tx.box.update({
            where: { id: b.id },
            data: { status: "IN_FACILITY", currentFacilityId: facilityId },
          });

          await tx.boxEvent.create({
            data: {
              boxId: b.id,
              type: "FACILITY_RECEIVE",
              performedByUserId: req.user.id,
              toFacilityId: facilityId,
              note: note || null,
            },
          });
        }
      });

      return res.json({ message: "Facility receive complete", count: boxUids.length });
    } catch (err) {
      return res.status(400).json({ message: "Failed", error: String(err.message || err) });
    }
  }
);

// POST /api/transactions/dispense
// Body: { "boxUid": "SPO-...-00001", "note": "optional" }
router.post(
  "/dispense",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    const { boxUid, note } = req.body;
    if (!boxUid) return res.status(400).json({ message: "boxUid is required" });
    if (!req.user.facilityId) return res.status(400).json({ message: "Your user has no facilityId assigned" });

    try {
      const facilityId = req.user.facilityId;
      const box = await prisma.box.findUnique({ where: { boxUid: String(boxUid) } });
      if (!box) return res.status(404).json({ message: "Box not found" });

      if (box.status !== "IN_FACILITY" || box.currentFacilityId !== facilityId) {
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
            fromFacilityId: facilityId,
            note: note || null,
          },
        });
      });

      return res.json({ message: "Dispensed", boxUid: box.boxUid });
    } catch (err) {
      return res.status(400).json({ message: "Failed", error: String(err.message || err) });
    }
  }
);

module.exports = router;
