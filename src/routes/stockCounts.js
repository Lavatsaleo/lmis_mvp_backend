// Physical stock counts (stock take).
//
// Start a count for a warehouse (optionally one product): Anchor lists every
// batch it expects there (per product / batch / expiry / donor). Counters enter
// the cartons they find, on the dashboard or phone, saving as they go, and can
// add batches the system does not show. On submit, expected quantities are
// re-read (stock may have moved during the count); shortages become a
// COUNT_VARIANCE write-off request that needs approval, surpluses are flagged
// for investigation.
//
//   GET  /api/stock-counts                 list (warehouseId, status)
//   POST /api/stock-counts                 { warehouseId?, productId?, note? }
//   GET  /api/stock-counts/:id
//   PATCH /api/stock-counts/:id/lines      { lines: [{ id, countedBoxes, note? }] }
//   POST /api/stock-counts/:id/lines       { productId, batchNo, expiryDate, donorId?, countedBoxes, note? }  (found stock)
//   POST /api/stock-counts/:id/submit
//   POST /api/stock-counts/:id/cancel

const express = require("express");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { requireModule } = require("../middleware/modules");
const { isSuperAdmin } = require("../auth/access");
const { audit } = require("../auth/audit");
const { visibleWarehouseIds, canOperateWarehouse, OPERATOR_ROLES } = require("../warehouse/common");
const { HttpError, sendError, reference, groupKey, resolveWarehouseBoxes } = require("../warehouse/stock");
const { createAdjustment } = require("./stockAdjustments");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

async function operableWarehouse(req, warehouseId) {
  const warehouse = warehouseId ? await prisma.facility.findUnique({ where: { id: String(warehouseId) } }) : null;
  if (!warehouse || warehouse.type !== "WAREHOUSE") throw new HttpError(400, "Choose a warehouse");
  if (!canOperateWarehouse(req.user, warehouse)) throw new HttpError(403, "You can only count stock in your own warehouse");
  return warehouse;
}

/** Expected boxes per pallet group right now. */
async function currentGroups(warehouseId, productId) {
  const rows = await prisma.box.groupBy({
    by: ["productId", "batchNo", "expiryDate", "donorId"],
    where: { status: "IN_WAREHOUSE", currentFacilityId: warehouseId, ...(productId ? { productId } : {}) },
    _count: { _all: true },
  });
  const map = new Map();
  for (const r of rows) {
    const key = groupKey(r.productId, r.batchNo, r.expiryDate, r.donorId);
    const prev = map.get(key);
    // Same calendar day with different times collapses into one group.
    map.set(key, { productId: r.productId, batchNo: r.batchNo, expiryDate: r.expiryDate, donorId: r.donorId, boxes: (prev?.boxes || 0) + r._count._all });
  }
  return map;
}

async function loadVisible(req, id) {
  const count = await prisma.stockCount.findUnique({
    where: { id: String(id) },
    include: {
      warehouse: { select: { id: true, code: true, name: true, implementationId: true, type: true } },
      startedBy: { select: { id: true, fullName: true } },
      submittedBy: { select: { id: true, fullName: true } },
      adjustment: { select: { id: true, adjustmentNumber: true, status: true } },
      lines: true,
    },
  });
  if (!count) throw new HttpError(404, "Stock count not found");
  const ids = await visibleWarehouseIds(req, prisma);
  if (ids !== null && !ids.includes(count.warehouseId)) throw new HttpError(404, "Stock count not found");
  return count;
}

async function serialize(count, user) {
  const productIds = [...new Set(count.lines.map((l) => l.productId))];
  const donorIds = [...new Set(count.lines.map((l) => l.donorId).filter(Boolean))];
  const [products, donors] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true, packUnitName: true } }),
    prisma.donor.findMany({ where: { id: { in: donorIds } }, select: { id: true, name: true } }),
  ]);
  const pMap = new Map(products.map((p) => [p.id, p]));
  const dMap = new Map(donors.map((d) => [d.id, d.name]));
  const lines = count.lines
    .map((l) => ({
      ...l,
      productName: pMap.get(l.productId)?.name || l.productId,
      packUnitName: pMap.get(l.productId)?.packUnitName || "Box",
      donorName: l.donorId ? dMap.get(l.donorId) || "Unknown donor" : "Unknown donor",
      variance: l.countedBoxes == null ? null : l.countedBoxes - l.expectedBoxes,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName) || new Date(a.expiryDate) - new Date(b.expiryDate) || a.batchNo.localeCompare(b.batchNo));
  const counted = lines.filter((l) => l.countedBoxes != null);
  return {
    ...count,
    lines,
    totals: {
      lines: lines.length,
      countedLines: counted.length,
      expectedBoxes: lines.reduce((s, l) => s + l.expectedBoxes, 0),
      countedBoxes: counted.reduce((s, l) => s + l.countedBoxes, 0),
      shortageBoxes: counted.reduce((s, l) => s + Math.max(0, -l.variance), 0),
      surplusBoxes: counted.reduce((s, l) => s + Math.max(0, l.variance), 0),
    },
    canEdit: count.status === "IN_PROGRESS" && canOperateWarehouse(user, count.warehouse),
  };
}

router.get("/", async (req, res) => {
  try {
    const ids = await visibleWarehouseIds(req, prisma);
    const where = {};
    if (ids !== null) where.warehouseId = { in: ids };
    if (isSuperAdmin(req.user) && req.query.implementationId) where.implementationId = String(req.query.implementationId);
    if (req.query.warehouseId) {
      if (ids !== null && !ids.includes(String(req.query.warehouseId))) return res.json({ rows: [] });
      where.warehouseId = String(req.query.warehouseId);
    }
    if (req.query.status) where.status = String(req.query.status).toUpperCase();
    const rows = await prisma.stockCount.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 100,
      include: {
        warehouse: { select: { id: true, code: true, name: true } },
        startedBy: { select: { fullName: true } },
        adjustment: { select: { id: true, adjustmentNumber: true, status: true } },
        lines: { select: { expectedBoxes: true, countedBoxes: true } },
      },
    });
    return res.json({
      rows: rows.map((c) => ({
        ...c,
        lines: undefined,
        totals: {
          lines: c.lines.length,
          countedLines: c.lines.filter((l) => l.countedBoxes != null).length,
          expectedBoxes: c.lines.reduce((s, l) => s + l.expectedBoxes, 0),
          countedBoxes: c.lines.reduce((s, l) => s + (l.countedBoxes || 0), 0),
        },
      })),
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const warehouse = await operableWarehouse(req, body.warehouseId || req.user.warehouseId);
    const open = await prisma.stockCount.findFirst({ where: { warehouseId: warehouse.id, status: "IN_PROGRESS" }, select: { id: true, countNumber: true } });
    if (open) throw new HttpError(409, `Count ${open.countNumber} is already in progress for this warehouse; finish or cancel it first`, { countId: open.id });
    const productId = body.productId ? String(body.productId) : null;
    const groups = await currentGroups(warehouse.id, productId);
    if (!groups.size) throw new HttpError(400, "There is no stock to count in this warehouse");
    const count = await prisma.stockCount.create({
      data: {
        countNumber: reference("CNT"),
        implementationId: warehouse.implementationId,
        warehouseId: warehouse.id,
        productId,
        note: body.note ? String(body.note).trim() : null,
        startedById: req.user.id,
        lines: {
          create: [...groups.entries()].map(([key, g]) => ({
            groupKey: key,
            productId: g.productId,
            batchNo: g.batchNo,
            expiryDate: g.expiryDate,
            donorId: g.donorId,
            expectedBoxes: g.boxes,
          })),
        },
      },
    });
    await audit(req, {
      action: "STOCK_COUNT_STARTED",
      targetType: "STOCK_COUNT",
      target: { id: count.id, name: count.countNumber },
      implementationId: warehouse.implementationId,
      details: { warehouse: warehouse.code, lines: groups.size },
    });
    return res.status(201).json(await serialize(await loadVisible(req, count.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    return res.json(await serialize(await loadVisible(req, req.params.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

async function editable(req) {
  const count = await loadVisible(req, req.params.id);
  if (count.status !== "IN_PROGRESS") throw new HttpError(400, "This count is closed");
  await operableWarehouse(req, count.warehouseId);
  return count;
}

router.patch("/:id/lines", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const count = await editable(req);
    const byId = new Map(count.lines.map((l) => [l.id, l]));
    const updates = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!updates.length) throw new HttpError(400, "Nothing to save");
    const now = new Date();
    await prisma.$transaction(
      updates.map((u) => {
        const line = byId.get(String(u.id));
        if (!line) throw new HttpError(400, "A line does not belong to this count");
        const counted = u.countedBoxes === null || u.countedBoxes === "" || u.countedBoxes === undefined ? null : Number(u.countedBoxes);
        if (counted !== null && (!Number.isInteger(counted) || counted < 0 || counted > 100000)) {
          throw new HttpError(400, `${line.batchNo}: counted cartons must be a whole number, zero or more`);
        }
        return prisma.stockCountLine.update({
          where: { id: line.id },
          data: { countedBoxes: counted, note: u.note !== undefined ? String(u.note || "").slice(0, 190) || null : line.note, countedAt: counted === null ? null : now },
        });
      })
    );
    return res.json(await serialize(await loadVisible(req, count.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/:id/lines", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const count = await editable(req);
    const b = req.body || {};
    const product = b.productId ? await prisma.product.findUnique({ where: { id: String(b.productId) } }) : null;
    if (!product || (product.implementationId && product.implementationId !== count.implementationId)) throw new HttpError(400, "Choose a product");
    if (count.productId && count.productId !== product.id) throw new HttpError(400, "This count only covers one product");
    const batchNo = String(b.batchNo || "").trim();
    if (!batchNo) throw new HttpError(400, "Batch number is required");
    const exp = new Date(b.expiryDate);
    if (Number.isNaN(exp.getTime())) throw new HttpError(400, "Expiry date is required");
    const counted = Number(b.countedBoxes);
    if (!Number.isInteger(counted) || counted < 0) throw new HttpError(400, "Counted cartons must be a whole number");
    let donorId = b.donorId ? String(b.donorId) : null;
    if (donorId) {
      const d = await prisma.donor.findUnique({ where: { id: donorId } });
      if (!d || d.implementationId !== count.implementationId) donorId = null;
    }
    const key = groupKey(product.id, batchNo, exp, donorId);
    await prisma.stockCountLine.upsert({
      where: { stockCountId_groupKey: { stockCountId: count.id, groupKey: key } },
      create: {
        stockCountId: count.id,
        groupKey: key,
        productId: product.id,
        batchNo,
        expiryDate: new Date(`${exp.toISOString().slice(0, 10)}T00:00:00.000Z`),
        donorId,
        expectedBoxes: 0,
        countedBoxes: counted,
        addedByCounter: true,
        note: b.note ? String(b.note).slice(0, 190) : null,
        countedAt: new Date(),
      },
      update: { countedBoxes: counted, countedAt: new Date() },
    });
    return res.status(201).json(await serialize(await loadVisible(req, count.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/:id/submit", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const count = await editable(req);
    const uncounted = count.lines.filter((l) => l.countedBoxes == null);
    if (uncounted.length) {
      throw new HttpError(400, `${uncounted.length} line${uncounted.length === 1 ? " is" : "s are"} not counted yet; enter 0 where nothing was found`, { uncounted: uncounted.length });
    }
    const warehouse = count.warehouse;
    // Stock may have moved since the count started: compare with now.
    const now = await currentGroups(warehouse.id, count.productId);
    const shortages = [];
    let surplus = 0;
    const lineUpdates = [];
    for (const l of count.lines) {
      const expected = now.get(l.groupKey)?.boxes || 0;
      if (expected !== l.expectedBoxes) lineUpdates.push({ id: l.id, expectedBoxes: expected });
      const diff = l.countedBoxes - expected;
      if (diff < 0) shortages.push({ line: l, boxes: -diff });
      if (diff > 0) surplus += diff;
    }
    const arrivedAfter = [...now.keys()].filter((k) => !count.lines.some((l) => l.groupKey === k));

    const result = await prisma.$transaction(
      async (tx) => {
        for (const u of lineUpdates) await tx.stockCountLine.update({ where: { id: u.id }, data: { expectedBoxes: u.expectedBoxes } });
        let adjustment = null;
        if (shortages.length) {
          const boxes = await resolveWarehouseBoxes({
            warehouseId: warehouse.id,
            batches: shortages.map((s) => ({ productId: s.line.productId, batchNo: s.line.batchNo, expiryDate: s.line.expiryDate, donorId: s.line.donorId, boxes: s.boxes })),
          });
          adjustment = await createAdjustment(req, {
            warehouse,
            reason: "COUNT_VARIANCE",
            note: `Stock count ${count.countNumber}: ${shortages.reduce((s, x) => s + x.boxes, 0)} carton(s) missing. Boxes chosen from each short batch (highest label numbers); verify before approving.`,
            boxes,
            stockCountId: count.id,
            tx,
          });
        }
        await tx.stockCount.update({ where: { id: count.id }, data: { status: "SUBMITTED", submittedById: req.user.id, submittedAt: new Date() } });
        return { adjustmentId: adjustment?.id || null };
      },
      { maxWait: 15000, timeout: 120000 }
    );
    await audit(req, {
      action: "STOCK_COUNT_SUBMITTED",
      targetType: "STOCK_COUNT",
      target: { id: count.id, name: count.countNumber },
      implementationId: warehouse.implementationId,
      details: { shortageBoxes: shortages.reduce((s, x) => s + x.boxes, 0), surplusBoxes: surplus, adjustmentId: result.adjustmentId },
    });
    return res.json({
      ...(await serialize(await loadVisible(req, count.id), req.user)),
      result: {
        shortageBoxes: shortages.reduce((s, x) => s + x.boxes, 0),
        surplusBoxes: surplus,
        adjustmentId: result.adjustmentId,
        groupsArrivedDuringCount: arrivedAfter.length,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post("/:id/cancel", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const count = await editable(req);
    await prisma.stockCount.update({ where: { id: count.id }, data: { status: "CANCELLED", submittedById: req.user.id, submittedAt: new Date() } });
    await audit(req, {
      action: "STOCK_COUNT_CANCELLED",
      targetType: "STOCK_COUNT",
      target: { id: count.id, name: count.countNumber },
      implementationId: count.implementationId,
    });
    return res.json(await serialize(await loadVisible(req, count.id), req.user));
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
