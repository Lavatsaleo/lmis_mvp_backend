// Stock holds (quarantine) and write-offs (losses) with approval.
//
// Hold: boxes stay in the warehouse but cannot be dispatched (expired,
// suspected damage, recall, under investigation). Releasing puts them back.
// Write-off: a warehouse officer (or admin) requests it with a reason and
// evidence; the boxes go on hold at once. A SUPER_ADMIN, or the COUNTRY_ADMIN of
// that country, who is not the requester approves (boxes leave stock; partial
// boxes lose the units) or rejects (boxes are released).
//
//   GET    /api/stock-adjustments                    list (status, warehouseId, reason)
//   POST   /api/stock-adjustments                    request a write-off
//   GET    /api/stock-adjustments/:id
//   POST   /api/stock-adjustments/:id/approve        { note? }
//   POST   /api/stock-adjustments/:id/reject         { note }
//   POST   /api/stock-adjustments/:id/cancel         requester, while pending
//   POST   /api/stock-adjustments/:id/documents      raw PDF/JPEG/PNG, X-File-Name
//   GET    /api/stock-adjustments/:id/documents/:docId
//   POST   /api/stock-adjustments/holds              { warehouseId, boxUids?, batches?, expiredOnly?, reason }
//   POST   /api/stock-adjustments/holds/release      { warehouseId, boxUids?, batches?, all? }
//   GET    /api/stock-adjustments/holds?warehouseId=  boxes on hold

const express = require("express");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { requireModule } = require("../middleware/modules");
const { isSuperAdmin, isCountryAdmin } = require("../auth/access");
const { audit } = require("../auth/audit");
const { visibleWarehouseIds, canOperateWarehouse, OPERATOR_ROLES, boxUnitValue, BOX_VALUE_SELECT, productValueSelect } = require("../warehouse/common");
const { HttpError, sendError, reference, resolveWarehouseBoxes, DOC_TYPES, MAX_DOC_BYTES, readUpload, sendDocument } = require("../warehouse/stock");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

const REASONS = ["EXPIRED", "DAMAGED", "LOST", "THEFT", "CONTAMINATED", "RECALLED", "COUNT_VARIANCE", "OTHER"];
const MAX_BOXES = 5000;

async function operableWarehouse(req, warehouseId) {
  const warehouse = warehouseId ? await prisma.facility.findUnique({ where: { id: String(warehouseId) } }) : null;
  if (!warehouse || warehouse.type !== "WAREHOUSE") throw new HttpError(400, "Choose a warehouse");
  if (!canOperateWarehouse(req.user, warehouse)) throw new HttpError(403, "You can only manage stock in your own warehouse");
  return warehouse;
}

function canApprove(user, adjustment) {
  if (adjustment.requestedById === user.id) return false;
  if (isSuperAdmin(user)) return true;
  return isCountryAdmin(user) && user.implementationId === adjustment.implementationId;
}

const DETAIL_INCLUDE = {
  warehouse: { select: { id: true, code: true, name: true } },
  requestedBy: { select: { id: true, fullName: true, role: true } },
  decidedBy: { select: { id: true, fullName: true, role: true } },
  stockCount: { select: { id: true, countNumber: true } },
  documents: { orderBy: { createdAt: "asc" }, select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { fullName: true } } } },
  lines: { include: { box: { select: { boxUid: true, status: true, sachetsRemaining: true } } } },
};

async function serialize(adj, user) {
  const productIds = [...new Set(adj.lines.map((l) => l.productId))];
  const donorIds = [...new Set(adj.lines.map((l) => l.donorId).filter(Boolean))];
  const [products, donors] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, baseUnitName: true } }),
    prisma.donor.findMany({ where: { id: { in: donorIds } }, select: { id: true, name: true } }),
  ]);
  const pMap = new Map(products.map((p) => [p.id, p]));
  const dMap = new Map(donors.map((d) => [d.id, d]));
  const value = {};
  let units = 0;
  const groups = new Map();
  for (const l of adj.lines) {
    units += l.unitsWrittenOff;
    const v = l.unitValue == null ? null : Number(l.unitValue) * l.unitsWrittenOff;
    if (v != null) value[l.currencyCode || "USD"] = (value[l.currencyCode || "USD"] || 0) + v;
    const key = `${l.productId}|${l.batchNo}|${l.donorId || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        product: pMap.get(l.productId)?.name || l.productId,
        batchNo: l.batchNo,
        expiryDate: l.expiryDate,
        donor: dMap.get(l.donorId)?.name || "Unknown donor",
        boxes: 0,
        fullBoxes: 0,
        units: 0,
        value: 0,
        currency: l.currencyCode || null,
        boxUids: [],
      });
    }
    const g = groups.get(key);
    g.boxes += 1;
    if (l.fullBox) g.fullBoxes += 1;
    g.units += l.unitsWrittenOff;
    if (v != null) g.value += v;
    if (g.boxUids.length < 100) g.boxUids.push(l.box?.boxUid);
  }
  return {
    ...adj,
    lines: undefined,
    lineCount: adj.lines.length,
    groups: [...groups.values()].map((g) => ({ ...g, value: Number(g.value.toFixed(2)) })),
    totals: {
      boxes: adj.lines.length,
      fullBoxes: adj.lines.filter((l) => l.fullBox).length,
      units,
      value: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Number(v.toFixed(2))])),
    },
    canApprove: adj.status === "PENDING_APPROVAL" && canApprove(user, adj),
    canCancel: adj.status === "PENDING_APPROVAL" && adj.requestedById === user.id,
  };
}

async function loadVisible(req, id, include = DETAIL_INCLUDE) {
  const adj = await prisma.stockAdjustment.findUnique({ where: { id: String(id) }, include });
  if (!adj) throw new HttpError(404, "Adjustment not found");
  const ids = await visibleWarehouseIds(req, prisma);
  if (ids !== null && !ids.includes(adj.warehouseId)) throw new HttpError(404, "Adjustment not found");
  return adj;
}

// ---------------------------------------------------------------------------
// Holds (registered before /:id so the paths do not collide)
// ---------------------------------------------------------------------------
router.get("/holds", async (req, res) => {
  try {
    const ids = await visibleWarehouseIds(req, prisma);
    const where = { status: "IN_WAREHOUSE", heldAt: { not: null } };
    if (req.query.warehouseId) {
      if (ids !== null && !ids.includes(String(req.query.warehouseId))) return res.json({ rows: [] });
      where.currentFacilityId = String(req.query.warehouseId);
    } else if (ids !== null) where.currentFacilityId = { in: ids };
    const boxes = await prisma.box.findMany({
      where,
      orderBy: [{ heldAt: "desc" }],
      take: 5000,
      select: {
        boxUid: true,
        batchNo: true,
        expiryDate: true,
        heldAt: true,
        holdReason: true,
        holdAdjustmentId: true,
        sachetsRemaining: true,
        currentFacilityId: true,
        product: { select: { name: true } },
        donor: { select: { name: true } },
      },
    });
    return res.json({ rows: boxes });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/holds", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const warehouse = await operableWarehouse(req, body.warehouseId || req.user.warehouseId);
    const reason = String(body.reason || "").trim();
    if (!reason) throw new HttpError(400, "Give a reason for the hold");
    const boxes = await resolveWarehouseBoxes({ warehouseId: warehouse.id, boxUids: body.boxUids, batches: body.batches, expiredOnly: !!body.expiredOnly });
    const toHold = boxes.filter((b) => !b.heldAt);
    if (!toHold.length) throw new HttpError(400, boxes.length ? "Those boxes are already on hold" : "No matching boxes in stock");
    const result = await prisma.box.updateMany({
      where: { id: { in: toHold.map((b) => b.id) }, status: "IN_WAREHOUSE", heldAt: null },
      data: { heldAt: new Date(), holdReason: reason.slice(0, 190), heldById: req.user.id },
    });
    await audit(req, {
      action: "STOCK_HELD",
      targetType: "WAREHOUSE",
      target: { id: warehouse.id, name: warehouse.code },
      implementationId: warehouse.implementationId,
      details: { boxes: result.count, reason },
    });
    return res.json({ held: result.count });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/holds/release", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const warehouse = await operableWarehouse(req, body.warehouseId || req.user.warehouseId);
    let ids;
    if (body.all) {
      ids = (await prisma.box.findMany({ where: { currentFacilityId: warehouse.id, status: "IN_WAREHOUSE", heldAt: { not: null }, holdAdjustmentId: null }, select: { id: true } })).map((b) => b.id);
    } else {
      const boxes = await resolveWarehouseBoxes({ warehouseId: warehouse.id, boxUids: body.boxUids, batches: body.batches });
      const blocked = boxes.filter((b) => b.holdAdjustmentId);
      if (blocked.length) throw new HttpError(400, "Some boxes are held by a pending write-off; approve, reject or cancel it instead");
      ids = boxes.filter((b) => b.heldAt).map((b) => b.id);
    }
    if (!ids.length) throw new HttpError(400, "None of those boxes are on hold");
    const result = await prisma.box.updateMany({
      where: { id: { in: ids }, holdAdjustmentId: null },
      data: { heldAt: null, holdReason: null, heldById: null },
    });
    await audit(req, {
      action: "STOCK_RELEASED",
      targetType: "WAREHOUSE",
      target: { id: warehouse.id, name: warehouse.code },
      implementationId: warehouse.implementationId,
      details: { boxes: result.count },
    });
    return res.json({ released: result.count });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const ids = await visibleWarehouseIds(req, prisma);
    const where = {};
    if (ids !== null) where.warehouseId = { in: ids };
    if (isSuperAdmin(req.user) && req.query.implementationId) where.implementationId = String(req.query.implementationId);
    if (req.query.warehouseId) {
      if (ids !== null && !ids.includes(String(req.query.warehouseId))) return res.json({ rows: [], total: 0 });
      where.warehouseId = String(req.query.warehouseId);
    }
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    if (req.query.reason) where.reason = String(req.query.reason).toUpperCase();
    const take = Math.min(200, Math.max(1, Number.parseInt(req.query.take || "50", 10) || 50));
    const [total, rows] = await Promise.all([
      prisma.stockAdjustment.count({ where }),
      prisma.stockAdjustment.findMany({ where, orderBy: { requestedAt: "desc" }, take, include: DETAIL_INCLUDE }),
    ]);
    return res.json({ total, rows: await Promise.all(rows.map((r) => serialize(r, req.user))) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Request a write-off
// Body: { warehouseId?, reason, note, boxUids?, batches?, expiredOnly?, partial?: [{ boxUid, units }] }
// ---------------------------------------------------------------------------
async function createAdjustment(req, { warehouse, reason, note, boxes, partialUnits = new Map(), stockCountId = null, clientRequestId = null, tx = prisma }) {
  if (!boxes.length) throw new HttpError(400, "Choose the boxes to write off");
  if (boxes.length > MAX_BOXES) throw new HttpError(400, `At most ${MAX_BOXES} boxes per write-off`);

  const valued = await tx.box.findMany({
    where: { id: { in: boxes.map((b) => b.id) } },
    select: { ...BOX_VALUE_SELECT, id: true, productId: true, expiryDate: true, donorId: true, product: { select: productValueSelect() } },
  });
  const adjustmentNumber = reference("ADJ");
  const adj = await tx.stockAdjustment.create({
    data: {
      adjustmentNumber,
      implementationId: warehouse.implementationId,
      warehouseId: warehouse.id,
      reason,
      note,
      requestedById: req.user.id,
      stockCountId,
      clientRequestId,
      lines: {
        create: valued.map((b) => {
          const partial = partialUnits.get(b.id);
          const units = partial ?? b.sachetsRemaining;
          const v = boxUnitValue(b);
          return {
            boxId: b.id,
            productId: b.productId,
            batchNo: b.batchNo,
            expiryDate: b.expiryDate,
            donorId: b.donorId,
            unitsBefore: b.sachetsRemaining,
            unitsWrittenOff: units,
            fullBox: units >= b.sachetsRemaining,
            unitValue: v.unitValue == null || !Number.isFinite(v.unitValue) ? null : v.unitValue,
            currencyCode: v.currencyCode || null,
          };
        }),
      },
    },
  });
  // Put the boxes on hold until a decision.
  const held = await tx.box.updateMany({
    where: { id: { in: boxes.map((b) => b.id) }, status: "IN_WAREHOUSE", OR: [{ holdAdjustmentId: null }, { holdAdjustmentId: adj.id }] },
    data: { heldAt: new Date(), holdReason: `Pending write-off ${adjustmentNumber} (${reason.toLowerCase().replace("_", " ")})`, heldById: req.user.id, holdAdjustmentId: adj.id },
  });
  if (held.count !== boxes.length) throw new HttpError(409, "Some boxes changed while the request was being saved; refresh and try again");
  return adj;
}

router.post(
  "/",
  requireRole(...OPERATOR_ROLES),
  async (req, res) => {
    try {
      const body = req.body || {};
      const idem = req.header("X-Idempotency-Key");
      const clientRequestId = idem && String(idem).trim().length <= 191 ? String(idem).trim() : null;
      if (clientRequestId) {
        const prior = await prisma.stockAdjustment.findUnique({ where: { clientRequestId }, select: { id: true } });
        if (prior) return res.json({ ...(await serialize(await loadVisible(req, prior.id), req.user)), replayed: true });
      }
      const warehouse = await operableWarehouse(req, body.warehouseId || req.user.warehouseId);
      const reason = String(body.reason || "").toUpperCase();
      if (!REASONS.includes(reason) || reason === "COUNT_VARIANCE") {
        throw new HttpError(400, "Choose a reason: expired, damaged, lost, theft, contaminated, recalled or other");
      }
      const note = String(body.note || "").trim();
      if (["LOST", "THEFT", "OTHER", "DAMAGED", "CONTAMINATED"].includes(reason) && note.length < 5) {
        throw new HttpError(400, "Describe what happened (at least a short sentence)");
      }

      // Partial boxes: some units damaged, the rest still usable.
      const partial = Array.isArray(body.partial) ? body.partial : [];
      const partialUids = partial.map((p) => String(p.boxUid || "").trim()).filter(Boolean);
      const boxes = await resolveWarehouseBoxes({
        warehouseId: warehouse.id,
        boxUids: [...(body.boxUids || []), ...partialUids],
        batches: body.batches,
        expiredOnly: !!body.expiredOnly,
      });
      const byUid = new Map(boxes.map((b) => [b.boxUid, b]));
      const partialUnits = new Map();
      for (const p of partial) {
        const b = byUid.get(String(p.boxUid || "").trim());
        const units = Number(p.units);
        if (!b) continue;
        if (!Number.isInteger(units) || units <= 0 || units > b.sachetsRemaining) {
          throw new HttpError(400, `${b.boxUid}: units must be between 1 and ${b.sachetsRemaining}`);
        }
        partialUnits.set(b.id, units);
      }
      if (reason === "EXPIRED") {
        const notExpired = boxes.filter((b) => new Date(b.expiryDate) > new Date());
        if (notExpired.length) throw new HttpError(400, `${notExpired.length} of these boxes are not expired yet; use another reason`);
      }

      const adj = await prisma.$transaction(
        (tx) => createAdjustment(req, { warehouse, reason, note: note || null, boxes, partialUnits, clientRequestId, tx }),
        { maxWait: 15000, timeout: 60000 }
      );
      await audit(req, {
        action: "WRITE_OFF_REQUESTED",
        targetType: "STOCK_ADJUSTMENT",
        target: { id: adj.id, name: adj.adjustmentNumber },
        implementationId: warehouse.implementationId,
        details: { reason, boxes: boxes.length, warehouse: warehouse.code },
      });
      return res.status(201).json(await serialize(await loadVisible(req, adj.id), req.user));
    } catch (err) {
      return sendError(res, err);
    }
  }
);

router.get("/:id", async (req, res) => {
  try {
    return res.json(await serialize(await loadVisible(req, req.params.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------
router.post("/:id/approve", requireRole("SUPER_ADMIN", "COUNTRY_ADMIN"), async (req, res) => {
  try {
    const adj = await loadVisible(req, req.params.id, { lines: true });
    if (adj.status !== "PENDING_APPROVAL") throw new HttpError(400, `This write-off is already ${adj.status.toLowerCase().replace("_", " ")}`);
    if (adj.requestedById === req.user.id) throw new HttpError(403, "You cannot approve your own write-off; another administrator must approve it", { code: "SELF_APPROVAL" });
    if (!canApprove(req.user, adj)) throw new HttpError(403, "Only a Super Admin or this country's Country Admin can approve write-offs");
    const note = String(req.body?.note || "").trim() || null;
    const now = new Date();

    await prisma.$transaction(
      async (tx) => {
        const flipped = await tx.stockAdjustment.updateMany({
          where: { id: adj.id, status: "PENDING_APPROVAL" },
          data: { status: "APPROVED", decidedById: req.user.id, decidedAt: now, decisionNote: note },
        });
        if (flipped.count !== 1) throw new HttpError(409, "This write-off was just decided by someone else");
        for (const l of adj.lines) {
          const box = await tx.box.findUnique({ where: { id: l.boxId }, select: { sachetsRemaining: true, status: true, holdAdjustmentId: true } });
          if (!box || box.status !== "IN_WAREHOUSE" || box.holdAdjustmentId !== adj.id) {
            throw new HttpError(409, "A box in this write-off is no longer on hold in the warehouse; reject and re-create it");
          }
          const remaining = Math.max(0, box.sachetsRemaining - l.unitsWrittenOff);
          await tx.box.update({
            where: { id: l.boxId },
            data: {
              sachetsRemaining: remaining,
              status: remaining === 0 ? "VOID" : "IN_WAREHOUSE",
              heldAt: null,
              holdReason: null,
              heldById: null,
              holdAdjustmentId: null,
            },
          });
        }
        await tx.boxEvent.createMany({
          data: adj.lines.map((l) => ({
            boxId: l.boxId,
            type: "ADJUSTMENT",
            performedByUserId: req.user.id,
            fromFacilityId: adj.warehouseId,
            note: `Write-off ${adj.adjustmentNumber} (${adj.reason.toLowerCase()}): ${l.unitsWrittenOff} unit(s)${l.fullBox ? ", box removed from stock" : ""}`,
            createdAt: now,
          })),
        });
      },
      { maxWait: 15000, timeout: 120000 }
    );
    await audit(req, {
      action: "WRITE_OFF_APPROVED",
      targetType: "STOCK_ADJUSTMENT",
      target: { id: adj.id, name: adj.adjustmentNumber },
      implementationId: adj.implementationId,
      details: { boxes: adj.lines.length, reason: adj.reason, note },
    });
    return res.json(await serialize(await loadVisible(req, adj.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

async function closeWithoutWriteOff(req, res, status) {
  try {
    const adj = await loadVisible(req, req.params.id, { lines: true });
    if (adj.status !== "PENDING_APPROVAL") throw new HttpError(400, `This write-off is already ${adj.status.toLowerCase().replace("_", " ")}`);
    const note = String(req.body?.note || "").trim();
    if (status === "REJECTED") {
      if (!canApprove(req.user, adj)) {
        throw new HttpError(403, adj.requestedById === req.user.id ? "Cancel your own request instead of rejecting it" : "Only an administrator can reject write-offs");
      }
      if (!note) throw new HttpError(400, "Give a reason for rejecting");
    } else if (adj.requestedById !== req.user.id) {
      throw new HttpError(403, "Only the person who requested it can cancel this write-off");
    }
    await prisma.$transaction(async (tx) => {
      const flipped = await tx.stockAdjustment.updateMany({
        where: { id: adj.id, status: "PENDING_APPROVAL" },
        data: { status, decidedById: req.user.id, decidedAt: new Date(), decisionNote: note || null },
      });
      if (flipped.count !== 1) throw new HttpError(409, "This write-off was just decided by someone else");
      // Release the hold placed by this request.
      await tx.box.updateMany({ where: { holdAdjustmentId: adj.id }, data: { heldAt: null, holdReason: null, heldById: null, holdAdjustmentId: null } });
    });
    await audit(req, {
      action: status === "REJECTED" ? "WRITE_OFF_REJECTED" : "WRITE_OFF_CANCELLED",
      targetType: "STOCK_ADJUSTMENT",
      target: { id: adj.id, name: adj.adjustmentNumber },
      implementationId: adj.implementationId,
      details: { note },
    });
    return res.json(await serialize(await loadVisible(req, adj.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
}

router.post("/:id/reject", requireRole("SUPER_ADMIN", "COUNTRY_ADMIN"), (req, res) => closeWithoutWriteOff(req, res, "REJECTED"));
router.post("/:id/cancel", requireRole(...OPERATOR_ROLES), (req, res) => closeWithoutWriteOff(req, res, "CANCELLED"));

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
router.post(
  "/:id/documents",
  requireRole(...OPERATOR_ROLES),
  express.raw({ type: [...DOC_TYPES], limit: MAX_DOC_BYTES }),
  async (req, res) => {
    try {
      const adj = await loadVisible(req, req.params.id, {});
      await operableWarehouse(req, adj.warehouseId).catch(async (e) => {
        // Approvers may attach evidence too.
        if (!canApprove(req.user, adj)) throw e;
      });
      const file = readUpload(req);
      const doc = await prisma.stockAdjustmentDocument.create({
        data: { adjustmentId: adj.id, ...file, sizeBytes: file.data.length, uploadedById: req.user.id },
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
      await audit(req, {
        action: "WRITE_OFF_EVIDENCE_ADDED",
        targetType: "STOCK_ADJUSTMENT",
        target: { id: adj.id, name: adj.adjustmentNumber },
        implementationId: adj.implementationId,
        details: { fileName: file.fileName },
      });
      return res.status(201).json(doc);
    } catch (err) {
      if (err?.type === "entity.too.large") return res.status(413).json({ message: "File is larger than 15 MB" });
      return sendError(res, err);
    }
  }
);

router.get("/:id/documents/:docId", async (req, res) => {
  try {
    const adj = await loadVisible(req, req.params.id, {});
    const doc = await prisma.stockAdjustmentDocument.findFirst({ where: { id: String(req.params.docId), adjustmentId: adj.id } });
    if (!doc) throw new HttpError(404, "Document not found");
    return sendDocument(req, res, doc);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
module.exports.createAdjustment = createAdjustment;
