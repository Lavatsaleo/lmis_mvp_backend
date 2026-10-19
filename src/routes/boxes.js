const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { countryWideImplementationId, locationWithDescendants } = require("../auth/access");
const { requireRole } = require("../middleware/rbac");
const crypto = require("crypto");

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

function makeManifestNo() {
  // Example: MNF-20260222-3F7A
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `MNF-${y}${m}${day}-${suffix}`;
}

/**
 * GET /api/boxes?facilityId=xxx&status=IN_WAREHOUSE&take=500&skip=0
 * Used by the mobile app to cache boxes for offline workflows.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const facilityId = req.query.facilityId ? String(req.query.facilityId) : null;
    const status = req.query.status ? String(req.query.status).trim().toUpperCase() : null;

    const take = Math.min(Number(req.query.take || 1000), 5000);
    const skip = Math.max(Number(req.query.skip || 0), 0);

    if (!facilityId) {
      return res.status(400).json({ message: "facilityId is required" });
    }

    // validate status if provided
    const allowedStatuses = new Set([
      "CREATED",
      "IN_WAREHOUSE",
      "IN_TRANSIT",
      "IN_FACILITY",
      "DISPENSED",
      "VOID",
    ]);
    if (status && !allowedStatuses.has(status)) {
      return res.status(400).json({ message: "Invalid status", allowed: [...allowedStatuses] });
    }

    // facility exists?
    const facility = await prisma.facility.findUnique({ where: { id: facilityId } });
    if (!facility) return res.status(404).json({ message: "Facility not found" });

    // scope rules (keep it simple + safe for MVP)
    const countryId = countryWideImplementationId(req.user);
    if (countryId) {
      // COUNTRY_ADMIN / country-wide VIEWER: any location in their country.
      if (facility.implementationId !== countryId) {
        return res.status(403).json({ message: "Forbidden: not in your country" });
      }
    } else if (req.user.role === "VIEWER" && req.user.facilityType === "WAREHOUSE") {
      // A viewer on a warehouse reads everything below it.
      const ids = await locationWithDescendants(req.user.facilityId);
      if (!ids.includes(facility.id)) {
        return res.status(403).json({ message: "Forbidden: not in your warehouse scope" });
      }
    } else if (req.user.role !== "SUPER_ADMIN") {
      const myFacilityId = req.user.facilityId ? String(req.user.facilityId) : null;

      // If user is a warehouse officer OR assigned to a warehouse: allow warehouse + its child facilities
      if (req.user.role === "WAREHOUSE_OFFICER" || req.user.facilityType === "WAREHOUSE") {
        const myWarehouseId = req.user.warehouseId ? String(req.user.warehouseId) : null;

        const ok =
          (myWarehouseId && facility.id === myWarehouseId) ||
          (myWarehouseId && facility.warehouseId === myWarehouseId) ||
          // Locations directly below this warehouse, e.g. its field bases.
          (myWarehouseId && facility.parentStockLocationId === myWarehouseId);

        if (!ok) {
          return res.status(403).json({ message: "Forbidden: not in your warehouse scope" });
        }
      } else {
        // facility users: only their facility
        if (!myFacilityId || facility.id !== myFacilityId) {
          return res.status(403).json({ message: "Forbidden: you can only view your own facility boxes" });
        }
      }
    }

    const where = { currentFacilityId: facilityId };
    if (status) where.status = status;

    const boxes = await prisma.box.findMany({
      where,
      select: {
        boxUid: true,
        status: true,
        currentFacilityId: true,
        orderId: true,
        productId: true,
        batchNo: true,
        expiryDate: true,
        sachetsPerBox: true,
        sachetsRemaining: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take,
      skip,
    });

    // The app accepts either an array OR {boxes:[...]} — we return a wrapper.
    return res.json({ facilityId, count: boxes.length, boxes });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ============================================================================
// 0B) FACILITY STORE SUMMARY (boxes + sachets)
// GET /api/boxes/store/summary
//
// Returns counts for the logged-in facility store:
//  - boxesInStore: number of boxes currently IN_FACILITY
//  - totalSachetsRemaining: sum of sachetsRemaining across those boxes
//
// NOTE:
// - Facility users can only view their own facility.
// - SUPER_ADMIN can optionally pass ?facilityId=...
// ============================================================================
router.get(
  "/store/summary",
  requireAuth,
  requireRole("SUPER_ADMIN", "FACILITY_OFFICER", "CLINICIAN"),
  async (req, res) => {
    try {
      let facilityId = req.user.facilityId ? String(req.user.facilityId) : null;
      if (req.user.role === "SUPER_ADMIN" && req.query.facilityId) {
        facilityId = String(req.query.facilityId);
      }

      if (!facilityId) {
        return res.status(400).json({ message: "facilityId is required (or assign user a facility)" });
      }

      // Facility scoping
      if (req.user.role !== "SUPER_ADMIN" && String(req.user.facilityId) !== String(facilityId)) {
        return res.status(403).json({ message: "Forbidden: you can only view your own facility store" });
      }

      const facility = await prisma.facility.findUnique({ where: { id: facilityId } });
      if (!facility) return res.status(404).json({ message: "Facility not found" });

      const boxes = await prisma.box.findMany({
        where: { currentFacilityId: facilityId, status: "IN_FACILITY" },
        select: {
          boxUid: true,
          batchNo: true,
          expiryDate: true,
          productId: true,
          sachetsPerBox: true,
          sachetsRemaining: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const totalSachetsRemaining = boxes.reduce((acc, b) => {
        const perBox = Number.isFinite(b.sachetsPerBox) ? b.sachetsPerBox : 600;
        const rem = Number.isFinite(b.sachetsRemaining) ? b.sachetsRemaining : perBox;
        return acc + rem;
      }, 0);

      return res.json({
        facilityId,
        facility: { id: facility.id, code: facility.code, name: facility.name },
        boxesInStore: boxes.length,
        totalSachetsRemaining,
        boxes: boxes.map((b) => ({
          boxUid: b.boxUid,
          batchNo: b.batchNo,
          expiryDate: new Date(b.expiryDate).toISOString().slice(0, 10),
          sachetsPerBox: b.sachetsPerBox,
          sachetsRemaining: b.sachetsRemaining,
        })),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);


// ============================================================================
// 0C) WAREHOUSE STOCK SUMMARY (boxes + sachets)
// GET /api/boxes/warehouse/summary
//
// Returns counts for the logged-in warehouse:
//  - boxesInWarehouse: number of boxes currently IN_WAREHOUSE
//  - totalSachetsAvailable: sum of sachetsRemaining across those boxes
//
// NOTE:
// - WAREHOUSE_OFFICER can only view their own warehouse.
// - SUPER_ADMIN can optionally pass ?warehouseId=...
// ============================================================================
router.get(
  "/warehouse/summary",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      let warehouseId = req.user.warehouseId ? String(req.user.warehouseId) : null;

      if (req.user.role === "SUPER_ADMIN" && req.query.warehouseId) {
        warehouseId = String(req.query.warehouseId);
      }

      if (!warehouseId) {
        return res.status(400).json({ message: "warehouseId is required (or assign user a warehouse)" });
      }

      // Warehouse scoping
      if (req.user.role !== "SUPER_ADMIN" && String(req.user.warehouseId) !== String(warehouseId)) {
        return res.status(403).json({ message: "Forbidden: you can only view your own warehouse stock" });
      }

      const warehouse = await prisma.facility.findUnique({ where: { id: warehouseId } });
      if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });
      if (warehouse.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "Provided warehouseId is not a WAREHOUSE facility" });
      }

      const boxes = await prisma.box.findMany({
        where: { currentFacilityId: warehouseId, status: "IN_WAREHOUSE" },
        select: {
          boxUid: true,
          batchNo: true,
          expiryDate: true,
          productId: true,
          sachetsPerBox: true,
          sachetsRemaining: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const totalSachetsAvailable = boxes.reduce((acc, b) => {
        const perBox = Number.isFinite(b.sachetsPerBox) ? b.sachetsPerBox : 600;
        const rem = Number.isFinite(b.sachetsRemaining) ? b.sachetsRemaining : perBox;
        return acc + rem;
      }, 0);

      return res.json({
        warehouseId,
        warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
        boxesInWarehouse: boxes.length,
        totalSachetsAvailable,
        boxes: boxes.map((b) => ({
          boxUid: b.boxUid,
          batchNo: b.batchNo,
          expiryDate: new Date(b.expiryDate).toISOString().slice(0, 10),
          sachetsPerBox: b.sachetsPerBox,
          sachetsRemaining: b.sachetsRemaining,
        })),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);


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

    // Scope to the user's implementation (country/programme). Staff still need
    // to look up boxes arriving from elsewhere in their programme, so this is
    // not limited to their own facility. Out-of-scope boxes look like 404s.
    if (req.user.role !== "SUPER_ADMIN") {
      const boxImplementationId = box.product?.implementationId || box.currentFacility?.implementationId || null;
      const userImplementationId = req.user.implementationId || null;
      if (boxImplementationId !== userImplementationId) {
        return res.status(404).json({ message: "Box not found" });
      }
    }

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

      // Dispatch only happens from a WAREHOUSE.
      // For warehouse users: FROM is always their assigned warehouse (not editable from client).
      // SUPER_ADMIN may pass fromFacilityId, but it must be a warehouse.
      let fromFacilityId = null;
      if (req.user.role === "WAREHOUSE_OFFICER" || req.user.facilityType === "WAREHOUSE") {
        fromFacilityId = req.user.warehouseId
          ? String(req.user.warehouseId)
          : req.user.facilityId
          ? String(req.user.facilityId)
          : null;
      } else {
        fromFacilityId = req.body.fromFacilityId
          ? String(req.body.fromFacilityId)
          : req.user.facilityId
          ? String(req.user.facilityId)
          : null;
      }

      const note = req.body.note ? String(req.body.note) : null;

      if (!boxUids.length) return res.status(400).json({ message: "boxUids is required (array)" });
      if (!toFacilityId) return res.status(400).json({ message: "toFacilityId is required" });
      if (!fromFacilityId)
        return res.status(400).json({ message: "fromFacilityId is required (or assign user a facility)" });

      const [fromFacility, toFacility] = await Promise.all([
        assertFacilityExists(fromFacilityId),
        assertFacilityExists(toFacilityId),
      ]);

      // Enforce types
      if (fromFacility.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "Dispatch must be FROM a WAREHOUSE facility" });
      }
      // Destination: a facility/site, or (warehouse-to-warehouse transfer) a
      // warehouse directly below this one, e.g. Juba main warehouse -> field base.
      const isWarehouseTransfer = toFacility.type === "WAREHOUSE";
      if (isWarehouseTransfer) {
        if (toFacility.id === fromFacility.id) {
          return res.status(400).json({ message: "A warehouse cannot dispatch to itself" });
        }
        if (String(toFacility.parentStockLocationId || "") !== String(fromFacility.id)) {
          return res.status(400).json({
            message: "Stock can only be transferred to a warehouse directly below this one (e.g. main warehouse to field base)",
          });
        }
      } else if (toFacility.type !== "FACILITY") {
        return res.status(400).json({ message: "Dispatch destination must be a FACILITY" });
      }

      // Enforce scope: never across implementations (countries/programmes).
      if (
        fromFacility.implementationId &&
        toFacility.implementationId &&
        String(fromFacility.implementationId) !== String(toFacility.implementationId)
      ) {
        return res.status(400).json({
          message: "Destination facility belongs to a different implementation than this warehouse",
        });
      }

      // Enforce scope: destination must be linked to this warehouse, either via
      // the legacy warehouseId or the generic stock-location parent. An unlinked
      // destination is no longer accepted by default; only SUPER_ADMIN may send to
      // one (same implementation), e.g. while a new facility is being set up.
      const linkedToSource =
        String(toFacility.warehouseId || "") === String(fromFacility.id) ||
        String(toFacility.parentStockLocationId || "") === String(fromFacility.id);
      const linkedElsewhere = !linkedToSource && (toFacility.warehouseId || toFacility.parentStockLocationId);

      if (linkedElsewhere || (!linkedToSource && req.user.role !== "SUPER_ADMIN")) {
        return res.status(400).json({
          message: "Destination facility is not linked to this warehouse",
          hint: "Link the facility to this warehouse (warehouseId) before dispatch",
        });
      }

      // Fetch boxes
      const boxes = await prisma.box.findMany({
        where: { boxUid: { in: boxUids } },
        select: { id: true, boxUid: true, status: true, currentFacilityId: true, heldAt: true, holdReason: true },
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

      // Boxes on hold (quarantine / pending write-off) must not leave.
      const held = boxes.filter((b) => b.heldAt);
      if (held.length) {
        return res.status(400).json({
          code: "BOXES_ON_HOLD",
          message: `${held.length} box${held.length === 1 ? " is" : "es are"} on hold and cannot be dispatched: ${held
            .slice(0, 5)
            .map((b) => `${b.boxUid} (${b.holdReason || "on hold"})`)
            .join(", ")}${held.length > 5 ? "…" : ""}`,
          held: held.slice(0, 25).map((b) => ({ boxUid: b.boxUid, holdReason: b.holdReason })),
        });
      }

      const boxIds = boxes.map((b) => b.id);

      // Idempotency: if the same queued request retries, return the already-created shipment.
      const idemKey = req.header("X-Idempotency-Key") ? String(req.header("X-Idempotency-Key")) : null;
      if (idemKey) {
        const existing = await prisma.shipment.findUnique({ where: { idempotencyKey: idemKey } });
        if (existing) {
          return res.json({
            message: "Dispatched (idempotent replay)",
            shipmentId: existing.id,
            manifestNo: existing.manifestNo,
            waybillUrl: `/api/shipments/${existing.id}/waybill.pdf`,
            fromFacility: { id: fromFacility.id, code: fromFacility.code, name: fromFacility.name },
            toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
            dispatchedCount: boxUids.length,
            sample: boxUids.slice(0, 10),
          });
        }
      }

      const manifestNo = req.body.manifestNo ? String(req.body.manifestNo) : makeManifestNo();

      // Transaction: create shipment(manifest) + update boxes + create events
      let shipment = null;
      try {
      await prisma.$transaction(async (tx) => {
        shipment = await tx.shipment.create({
          data: {
            manifestNo,
            status: "DISPATCHED",
            note: note || null,
            fromWarehouseId: fromFacilityId,
            toFacilityId,
            dispatchedByUserId: req.user.id,
            idempotencyKey: idemKey || null,
          },
        });

        await tx.shipmentItem.createMany({
          data: boxIds.map((id) => ({ shipmentId: shipment.id, boxId: id })),
          skipDuplicates: true,
        });

        // Conditional: the eligibility check above ran outside this transaction,
        // so re-check at write time. If another dispatch took any of these boxes
        // first, roll back rather than put the same box on two manifests.
        const moved = await tx.box.updateMany({
          where: { id: { in: boxIds }, status: "IN_WAREHOUSE", currentFacilityId: fromFacilityId },
          data: {
            status: "IN_TRANSIT",
            currentFacilityId: null, // remove from warehouse stock immediately
          },
        });
        if (moved.count !== boxIds.length) {
          const e = new Error("Some boxes were dispatched by another request in the meantime. Refresh and try again.");
          e.status = 409;
          throw e;
        }

        await tx.boxEvent.createMany({
          data: boxIds.map((id) => ({
            boxId: id,
            type: "DISPATCH",
            performedByUserId: req.user.id,
            fromFacilityId: fromFacilityId,
            toFacilityId: toFacilityId,
            note: note || `Dispatched (Manifest ${manifestNo}) from ${fromFacility.code} to ${toFacility.code}`,
          })),
        });
      });
      } catch (err) {
        // Same idempotency key sent twice at once: the other request created the
        // shipment, so answer as a replay instead of a 500.
        if (idemKey && err?.code === "P2002" && String(err?.meta?.target ?? "").includes("idempotencyKey")) {
          const existing = await prisma.shipment.findUnique({ where: { idempotencyKey: idemKey } });
          if (existing) {
            return res.json({
              message: "Dispatched (idempotent replay)",
              shipmentId: existing.id,
              manifestNo: existing.manifestNo,
              waybillUrl: `/api/shipments/${existing.id}/waybill.pdf`,
              fromFacility: { id: fromFacility.id, code: fromFacility.code, name: fromFacility.name },
              toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
              dispatchedCount: boxUids.length,
              sample: boxUids.slice(0, 10),
            });
          }
        }
        throw err;
      }

      return res.json({
        message: "Dispatched",
        shipmentId: shipment?.id || null,
        manifestNo,
        waybillUrl: shipment?.id ? `/api/shipments/${shipment.id}/waybill.pdf` : null,
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
// Also mounted as POST /api/boxes/receive. Besides facilities receiving from
// their warehouse, a field base WAREHOUSE_OFFICER receives warehouse-to-warehouse
// transfers here (against the manifest); those boxes become IN_WAREHOUSE.
async function receiveShipmentHandler(req, res) {
    try {
      const boxUids = uniqueStrings(req.body.boxUids);
      const note = req.body.note ? String(req.body.note) : null;

      // Receiving location is always the logged-in user's own facility or
      // warehouse. SUPER_ADMIN can specify toFacilityId.
      let toFacilityId = req.body.toFacilityId
        ? String(req.body.toFacilityId)
        : req.user.facilityId
        ? String(req.user.facilityId)
        : null;

      const receivesOwnLocationOnly = ["FACILITY_OFFICER", "CLINICIAN", "WAREHOUSE_OFFICER"].includes(req.user.role);
      if (receivesOwnLocationOnly) {
        toFacilityId = req.user.facilityId ? String(req.user.facilityId) : toFacilityId;
      }

      const shipmentId = req.body.shipmentId
        ? String(req.body.shipmentId)
        : req.body.manifestId
        ? String(req.body.manifestId)
        : null;

      if (!boxUids.length) return res.status(400).json({ message: "boxUids is required (array)" });
      if (!toFacilityId)
        return res.status(400).json({ message: "toFacilityId is required (or assign user a facility)" });

      // Scoping: staff can only receive into their own facility/warehouse.
      if (receivesOwnLocationOnly && String(req.user.facilityId) !== String(toFacilityId)) {
        return res.status(403).json({ message: "Forbidden: you can only receive into your own location" });
      }

      const toFacility = await assertFacilityExists(toFacilityId);

      // Warehouse-to-warehouse transfers are always received against their
      // manifest (no legacy manifest-less path for warehouses).
      const intoWarehouse = toFacility.type === "WAREHOUSE";
      if (intoWarehouse && !shipmentId) {
        return res.status(400).json({ message: "Receiving into a warehouse requires the shipment (manifest)" });
      }
      if (req.user.role === "WAREHOUSE_OFFICER" && !intoWarehouse) {
        return res.status(403).json({ message: "Forbidden: warehouse officers receive into their warehouse" });
      }

      // Fetch boxes
      const allBoxes = await prisma.box.findMany({
        where: { boxUid: { in: boxUids } },
        select: { id: true, boxUid: true, status: true, currentFacilityId: true },
      });

      if (allBoxes.length !== boxUids.length) {
        const found = new Set(allBoxes.map((b) => b.boxUid));
        const missing = boxUids.filter((u) => !found.has(u));
        return res.status(400).json({ message: "Some boxUids were not found", missing });
      }

      let shipment = null;
      let boxes = allBoxes;
      if (shipmentId) {
        shipment = await prisma.shipment.findUnique({
          where: { id: shipmentId },
          include: { items: { select: { boxId: true, receivedAt: true } } },
        });

        if (!shipment) return res.status(404).json({ message: "Shipment not found" });
        if (String(shipment.toFacilityId) !== String(toFacilityId)) {
          return res.status(400).json({
            message: "This shipment is not destined for your facility",
            shipmentToFacilityId: shipment.toFacilityId,
            yourFacilityId: toFacilityId,
          });
        }

        const itemByBoxId = new Map(shipment.items.map((i) => [i.boxId, i]));
        const unexpected = allBoxes.filter((b) => !itemByBoxId.has(b.id)).map((b) => b.boxUid);
        if (unexpected.length) {
          return res.status(400).json({
            message: "Some scanned boxes are not part of this shipment manifest",
            unexpected: unexpected.slice(0, 25),
          });
        }

        // Boxes this manifest already delivered here come from a retried or
        // duplicated sync of the same receive. Skip them instead of rejecting
        // the whole request (which would park it in NEEDS_REVIEW on the phone).
        boxes = allBoxes.filter((b) => {
          const item = itemByBoxId.get(b.id);
          return !(item?.receivedAt && String(b.currentFacilityId) === String(toFacilityId));
        });

        if (boxes.length === 0) {
          const remaining = shipment.items.filter((i) => !i.receivedAt).length;
          return res.json({
            message: "Facility received (manifest, already recorded)",
            replayed: true,
            shipmentId,
            toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
            receivedCount: 0,
            alreadyReceivedCount: allBoxes.length,
            remainingExpected: remaining,
            sample: boxUids.slice(0, 10),
          });
        }

        if (shipment.status !== "DISPATCHED") {
          return res.status(400).json({ message: "Shipment is not open for receiving", status: shipment.status });
        }
      }

      // Must be IN_TRANSIT
      const invalid = boxes
        .filter((b) => b.status !== "IN_TRANSIT")
        .map((b) => ({ id: b.id, boxUid: b.boxUid, status: b.status }));
      if (invalid.length) {
        return res.status(400).json({
          message: "Some boxes are not eligible for facility receive (must be IN_TRANSIT)",
          invalid: invalid.slice(0, 25),
        });
      }

      const boxIds = boxes.map((b) => b.id);

      // If shipmentId is provided, enforce receipt strictly against the manifest.
      if (shipment) {

        await prisma.$transaction(async (tx) => {
          // Conditional on IN_TRANSIT so a concurrent copy of this request cannot
          // also log receive events; the loser rolls back and its retry is a replay.
          const moved = await tx.box.updateMany({
            where: { id: { in: boxIds }, status: "IN_TRANSIT" },
            data: {
              // A field base receiving a transfer holds the stock as warehouse stock.
              status: intoWarehouse ? "IN_WAREHOUSE" : "IN_FACILITY",
              currentFacilityId: toFacilityId,
            },
          });
          if (moved.count !== boxIds.length) {
            const e = new Error("These boxes are being received by another request; retry shortly");
            e.status = 503;
            throw e;
          }

          await tx.boxEvent.createMany({
            data: boxIds.map((id) => ({
              boxId: id,
              type: intoWarehouse ? "WAREHOUSE_RECEIVE" : "FACILITY_RECEIVE",
              performedByUserId: req.user.id,
              fromFacilityId: shipment.fromWarehouseId,
              toFacilityId: toFacilityId,
              note:
                note ||
                `Received against manifest ${shipment.manifestNo} into ${intoWarehouse ? "warehouse" : "facility"} ${toFacility.code}`,
            })),
          });

          await tx.shipmentItem.updateMany({
            where: { shipmentId: shipment.id, boxId: { in: boxIds } },
            data: { receivedAt: new Date(), receivedByUserId: req.user.id },
          });

          const remaining = await tx.shipmentItem.count({
            where: { shipmentId: shipment.id, receivedAt: null },
          });
          if (remaining === 0) {
            await tx.shipment.update({
              where: { id: shipment.id },
              data: { status: "RECEIVED", receivedAt: new Date(), receivedByUserId: req.user.id },
            });
          }
        });

        const remaining = await prisma.shipmentItem.count({ where: { shipmentId, receivedAt: null } });

        return res.json({
          message: intoWarehouse ? "Warehouse received (manifest)" : "Facility received (manifest)",
          shipmentId,
          toFacility: { id: toFacility.id, code: toFacility.code, name: toFacility.name },
          receivedCount: boxIds.length,
          alreadyReceivedCount: allBoxes.length - boxIds.length,
          remainingExpected: remaining,
          sample: boxUids.slice(0, 10),
        });
      }

      // Fallback (legacy): Soft check last DISPATCH must be to this facility (prevents wrong facility receiving)

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
        const moved = await tx.box.updateMany({
          where: { id: { in: boxIds }, status: "IN_TRANSIT" },
          data: {
            status: "IN_FACILITY",
            currentFacilityId: toFacilityId,
          },
        });
        if (moved.count !== boxIds.length) {
          const e = new Error("These boxes are being received by another request; retry shortly");
          e.status = 503;
          throw e;
        }

        await tx.boxEvent.createMany({
          data: boxIds.map((id) => ({
            boxId: id,
            type: "FACILITY_RECEIVE",
            performedByUserId: req.user.id,
            toFacilityId: toFacilityId,
            note: note || `Received into facility ${toFacility.code}`,
          })),
        });

        // Received without naming the manifest: still tick these boxes off the
        // open shipment(s) they travelled on, and close any shipment that is now
        // complete. Otherwise the shipment stays DISPATCHED forever and shows up
        // as in transit / overdue.
        const openItems = await tx.shipmentItem.findMany({
          where: { boxId: { in: boxIds }, receivedAt: null, shipment: { status: "DISPATCHED", toFacilityId } },
          select: { id: true, shipmentId: true },
        });
        if (openItems.length) {
          const receivedAt = new Date();
          await tx.shipmentItem.updateMany({
            where: { id: { in: openItems.map((i) => i.id) } },
            data: { receivedAt, receivedByUserId: req.user.id },
          });
          for (const shipmentId of new Set(openItems.map((i) => i.shipmentId))) {
            const remaining = await tx.shipmentItem.count({ where: { shipmentId, receivedAt: null } });
            if (remaining === 0) {
              await tx.shipment.update({
                where: { id: shipmentId },
                data: { status: "RECEIVED", receivedAt, receivedByUserId: req.user.id },
              });
            }
          }
        }
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

const RECEIVE_ROLES = ["SUPER_ADMIN", "FACILITY_OFFICER", "CLINICIAN", "WAREHOUSE_OFFICER"];
router.post("/facility-receive", requireAuth, requireRole(...RECEIVE_ROLES), receiveShipmentHandler);
router.post("/receive", requireAuth, requireRole(...RECEIVE_ROLES), receiveShipmentHandler);

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
