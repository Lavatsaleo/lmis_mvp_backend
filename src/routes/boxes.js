const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

// ---------- small helpers ----------
function uniqueStrings(arr) {
  return [...new Set((arr || []).map(String).map((s) => s.trim()).filter(Boolean))];
}

async function assertFacilityExists(facilityId) {
  const f = await prisma.facility.findUnique({ where: { id: facilityId } });
  if (!f) {
    const err = new Error("Facility not found");
    err.status = 404;
    throw err;
  }
  return f;
}

// ============================================================================
// 1) BOX LOOKUP (useful for scanning in the app)
// GET /api/boxes/:boxUid
// ============================================================================
router.get("/:boxUid", requireAuth, async (req, res) => {
  try {
    const { boxUid } = req.params;

    const box = await prisma.box.findUnique({
      where: { boxUid },
      include: {
        order: true,
        product: true,
        currentFacility: true,
        events: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            performedBy: { select: { id: true, fullName: true, role: true } },
            fromFacility: true,
            toFacility: true,
          },
        },
      },
    });

    if (!box) return res.status(404).json({ message: "Box not found" });

    return res.json(box);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ============================================================================
// 2) DISPATCH (Warehouse -> Facility)
// POST /api/boxes/dispatch
// Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
//
// Body:
// {
//   "boxUids": ["SPO-ISL-00884-001-1","SPO-ISL-00884-001-2"],
//   "toFacilityId": "xxxx",
//   "fromFacilityId": "yyyy"   // optional; defaults to req.user.facilityId
//   "note": "Truck ABC 123"    // optional
// }
//
// Rules (MVP):
// - boxes MUST currently be in fromFacilityId AND status IN_WAREHOUSE
// - after dispatch: status IN_TRANSIT, currentFacilityId = null
// - logs BoxEvent: DISPATCH (fromFacilityId, toFacilityId)
// ============================================================================
router.post(
  "/dispatch",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const boxUids = uniqueStrings(req.body.boxUids);
      const toFacilityId = req.body.toFacilityId ? String(req.body.toFacilityId) : null;

      const fromFacilityId = req.body.fromFacilityId
        ? String(req.body.fromFacilityId)
        : req.user.facilityId
        ? String(req.user.facilityId)
        : null;

      const note = req.body.note ? String(req.body.note) : null;

      if (!boxUids.length) return res.status(400).json({ message: "boxUids is required (array)" });
      if (!toFacilityId) return res.status(400).json({ message: "toFacilityId is required" });
      if (!fromFacilityId)
        return res.status(400).json({ message: "fromFacilityId is required (or assign user a facility)" });

      const [fromFacility, toFacility] = await Promise.all([
        assertFacilityExists(fromFacilityId),
        assertFacilityExists(toFacilityId),
      ]);

      // Fetch boxes
      const boxes = await prisma.box.findMany({
        where: { boxUid: { in: boxUids } },
        select: { id: true, boxUid: true, status: true, currentFacilityId: true },
      });

      if (boxes.length !== boxUids.length) {
        const found = new Set(boxes.map((b) => b.boxUid));
        const missing = boxUids.filter((u) => !found.has(u));
        return res.status(400).json({ message: "Some boxUids were not found", missing });
      }

      // Validate all are IN_WAREHOUSE and in fromFacility
      const invalid = boxes.filter(
        (b) => b.status !== "IN_WAREHOUSE" || b.currentFacilityId !== fromFacilityId
      );

      if (invalid.length) {
        return res.status(400).json({
          message: "Some boxes are not eligible for dispatch (must be IN_WAREHOUSE and in the fromFacility)",
          invalid: invalid.slice(0, 25),
          hint: "Check status/currentFacilityId of the invalid boxes",
        });
      }

      const boxIds = boxes.map((b) => b.id);

      // Transaction: update boxes + create events
      await prisma.$transaction(async (tx) => {
        await tx.box.updateMany({
          where: { id: { in: boxIds } },
          data: {
            status: "IN_TRANSIT",
            currentFacilityId: null, // remove from warehouse stock immediately
          },
        });

        await tx.boxEvent.createMany({
          data: boxIds.map((id) => ({
            boxId: id,
            type: "DISPATCH",
            performedByUserId: req.user.id,
            fromFacilityId: fromFacilityId,
            toFacilityId: toFacilityId,
            note:
              note ||
              `Dispatched from ${fromFacility.code} to ${toFacility.code}`,
          })),
        });
      });

      return res.json({
        message: "Dispatched",
        fromFacility: { id: fromFacility.id, code: fromFacility.code, name: fromFacility.name },
        toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
        dispatchedCount: boxUids.length,
        sample: boxUids.slice(0, 10),
      });
    } catch (err) {
      console.error(err);
      const status = err.status || 500;
      return res.status(status).json({ message: err.message || "Server error" });
    }
  }
);

// ============================================================================
// 3) FACILITY RECEIVE (Facility confirms receipt)
// POST /api/boxes/facility-receive
// Roles: SUPER_ADMIN, FACILITY_OFFICER
//
// Body:
// {
//   "boxUids": ["SPO-...-1","SPO-...-2"],
//   "toFacilityId": "xxxx" // optional; if omitted uses req.user.facilityId
//   "note": "Received in good condition" // optional
// }
//
// Rules (MVP):
// - boxes MUST be IN_TRANSIT
// - (soft check) last DISPATCH event should have toFacilityId = receiving facility
// - after receive: status IN_FACILITY, currentFacilityId = toFacilityId
// - logs BoxEvent: FACILITY_RECEIVE
// ============================================================================
router.post(
  "/facility-receive",
  requireAuth,
  requireRole("SUPER_ADMIN", "FACILITY_OFFICER"),
  async (req, res) => {
    try {
      const boxUids = uniqueStrings(req.body.boxUids);
      const note = req.body.note ? String(req.body.note) : null;

      const toFacilityId = req.body.toFacilityId
        ? String(req.body.toFacilityId)
        : req.user.facilityId
        ? String(req.user.facilityId)
        : null;

      if (!boxUids.length) return res.status(400).json({ message: "boxUids is required (array)" });
      if (!toFacilityId)
        return res.status(400).json({ message: "toFacilityId is required (or assign user a facility)" });

      // Facility scoping: a FACILITY_OFFICER must receive into their own facility
      if (req.user.role === "FACILITY_OFFICER" && String(req.user.facilityId) !== String(toFacilityId)) {
        return res.status(403).json({ message: "Forbidden: you can only receive into your own facility" });
      }

      const toFacility = await assertFacilityExists(toFacilityId);

      // Fetch boxes
      const boxes = await prisma.box.findMany({
        where: { boxUid: { in: boxUids } },
        select: { id: true, boxUid: true, status: true },
      });

      if (boxes.length !== boxUids.length) {
        const found = new Set(boxes.map((b) => b.boxUid));
        const missing = boxUids.filter((u) => !found.has(u));
        return res.status(400).json({ message: "Some boxUids were not found", missing });
      }

      // Must be IN_TRANSIT
      const invalid = boxes.filter((b) => b.status !== "IN_TRANSIT");
      if (invalid.length) {
        return res.status(400).json({
          message: "Some boxes are not eligible for facility receive (must be IN_TRANSIT)",
          invalid: invalid.slice(0, 25),
        });
      }

      // Soft check: last DISPATCH must be to this facility (prevents wrong facility receiving)
      const boxIds = boxes.map((b) => b.id);

      const lastDispatches = await prisma.boxEvent.findMany({
        where: { boxId: { in: boxIds }, type: "DISPATCH" },
        orderBy: { createdAt: "desc" },
      });

      // Build last dispatch map per boxId
      const lastDispatchByBox = new Map();
      for (const ev of lastDispatches) {
        if (!lastDispatchByBox.has(ev.boxId)) lastDispatchByBox.set(ev.boxId, ev);
      }

      const wrongDestination = [];
      for (const b of boxes) {
        const ev = lastDispatchByBox.get(b.id);
        if (!ev || String(ev.toFacilityId) !== String(toFacilityId)) {
          wrongDestination.push({ boxUid: b.boxUid, reason: "Last dispatch is not to this facility" });
        }
      }

      if (wrongDestination.length) {
        return res.status(400).json({
          message: "Some boxes were not dispatched to this facility (destination mismatch)",
          wrongDestination: wrongDestination.slice(0, 25),
          hint: "Receive only boxes dispatched to this facility",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.box.updateMany({
          where: { id: { in: boxIds } },
          data: {
            status: "IN_FACILITY",
            currentFacilityId: toFacilityId,
          },
        });

        await tx.boxEvent.createMany({
          data: boxIds.map((id) => ({
            boxId: id,
            type: "FACILITY_RECEIVE",
            performedByUserId: req.user.id,
            toFacilityId: toFacilityId,
            note: note || `Received into facility ${toFacility.code}`,
          })),
        });
      });

      return res.json({
        message: "Facility received",
        toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
        receivedCount: boxUids.length,
        sample: boxUids.slice(0, 10),
      });
    } catch (err) {
      console.error(err);
      const status = err.status || 500;
      return res.status(status).json({ message: err.message || "Server error" });
    }
  }
);

// ============================================================================
// 4) STOCK SUMMARY (for dashboard)
// GET /api/boxes/stock/facility/:facilityId
//
// Returns counts by product+batch+expiry+status for boxes currently in that facility.
// Facility scoping:
// - SUPER_ADMIN can query any facility
// - Others can only query their own facility
// ============================================================================
router.get("/stock/facility/:facilityId", requireAuth, async (req, res) => {
  try {
    const { facilityId } = req.params;

    if (req.user.role !== "SUPER_ADMIN" && String(req.user.facilityId) !== String(facilityId)) {
      return res.status(403).json({ message: "Forbidden: you can only view your facility stock" });
    }

    await assertFacilityExists(facilityId);

    const grouped = await prisma.box.groupBy({
      by: ["productId", "batchNo", "expiryDate", "status"],
      where: { currentFacilityId: facilityId },
      _count: { _all: true },
      orderBy: [{ productId: "asc" }],
    });

    const productIds = [...new Set(grouped.map((g) => g.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, code: true, name: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const rows = grouped.map((g) => ({
      product: productMap.get(g.productId) || { id: g.productId, code: "UNKNOWN", name: "UNKNOWN" },
      batchNo: g.batchNo,
      expiryDate: new Date(g.expiryDate).toISOString().slice(0, 10),
      status: g.status,
      count: g._count._all,
    }));

    return res.json({
      facilityId,
      rows,
      totals: rows.reduce((acc, r) => acc + r.count, 0),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
