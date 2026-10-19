// Warehouse reports. Every report returns the same table shape so the
// dashboard can show and export any of them the same way:
//   { report, title, description, period, columns: [{key,label,type}], rows, totals, notes }
// column type: text | number | money | date | datetime | percent
//
//   GET /api/warehouse-reports                      list of reports
//   GET /api/warehouse-reports/:report?from&to&warehouseId&donorId&productId&expiryDays&implementationId
//
// Reports: stock-on-hand, stock-movement, daily-activity, activity-log,
//          donor-summary, expiry, purchase-orders, dispatches

const express = require("express");

const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
const { requireModule } = require("../middleware/modules");
const {
  visibleWarehouseWhere,
  boxUnitValue,
  BOX_VALUE_SELECT,
  productValueSelect,
  addMoney,
  roundMoney,
} = require("../warehouse/common");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

const DAY = 24 * 60 * 60 * 1000;

const REPORTS = [
  { key: "stock-on-hand", title: "Stock on hand", description: "What is in each warehouse now, by product, batch and donor, with value." },
  { key: "stock-movement", title: "Stock movement (ledger)", description: "Opening balance, received, dispatched and closing balance per warehouse and product for the period." },
  { key: "daily-activity", title: "Daily activity", description: "Receipts and dispatches per day and warehouse." },
  { key: "activity-log", title: "Activity log", description: "Every receipt, dispatch and transfer in the period, with who did it." },
  { key: "donor-summary", title: "Donor stock & value", description: "Per donor and product: received and dispatched in the period, and stock held now with its value." },
  { key: "expiry", title: "Expiry risk", description: "Batches in warehouses that are expired or expire within the chosen number of days, with value at risk." },
  { key: "purchase-orders", title: "Purchase order status", description: "Ordered vs received vs outstanding per purchase order, including overdue deliveries." },
  { key: "dispatches", title: "Dispatches", description: "Shipments sent from warehouses in the period, their value and receipt status." },
  { key: "losses", title: "Losses & write-offs", description: "Approved write-offs in the period by reason, product, batch and donor, with value lost." },
  { key: "stock-counts", title: "Stock counts", description: "Physical counts in the period: expected vs counted per batch, shortages and surpluses." },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseDate(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}` : s);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid date: ${s}`);
  return d;
}

/** Warehouses in scope for this request (respecting ?warehouseId). */
async function scopeWarehouses(req) {
  const where = await visibleWarehouseWhere(req);
  if (!where) return [];
  const filter = req.query.warehouseId ? { AND: [where, { id: String(req.query.warehouseId) }] } : where;
  return prisma.facility.findMany({
    where: filter,
    select: { id: true, code: true, name: true, implementationId: true, stockLocationType: true },
    orderBy: { name: "asc" },
  });
}

function periodFrom(req) {
  const now = new Date();
  const to = parseDate(req.query.to, true) || now;
  const from = parseDate(req.query.from) || new Date(to.getFullYear(), to.getMonth(), 1);
  if (from > to) throw new HttpError(400, "'From' must be before 'To'");
  if (to - from > 731 * DAY) throw new HttpError(400, "Choose a period of at most two years");
  return { from, to };
}

const sumBy = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const moneyLabel = (map) => {
  const entries = Object.entries(map);
  if (!entries.length) return null;
  return entries.length === 1 ? entries[0][1] : entries.map(([c, v]) => `${c} ${v.toLocaleString()}`).join(" + ");
};

function boxValueFor(box, units) {
  const v = boxUnitValue(box);
  if (v.unitValue == null || !Number.isFinite(v.unitValue)) return { value: null, currency: v.currencyCode };
  return { value: v.unitValue * units, currency: v.currencyCode };
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------
const BUILDERS = {
  async "stock-on-hand"(req, ctx) {
    const where = { status: "IN_WAREHOUSE", currentFacilityId: { in: ctx.ids } };
    if (req.query.donorId) where.donorId = String(req.query.donorId);
    if (req.query.productId) where.productId = String(req.query.productId);
    const boxes = await prisma.box.findMany({
      where,
      select: { ...BOX_VALUE_SELECT, currentFacilityId: true, expiryDate: true, productId: true, heldAt: true, donor: { select: { name: true } }, product: { select: productValueSelect() } },
    });
    const groups = new Map();
    const now = Date.now();
    for (const b of boxes) {
      const key = [b.currentFacilityId, b.productId, b.batchNo, b.expiryDate.toISOString(), b.donor?.name || "", b.heldAt ? "held" : ""].join("|");
      if (!groups.has(key)) {
        groups.set(key, {
          warehouse: ctx.byId.get(b.currentFacilityId)?.name,
          product: b.product.name,
          batchNo: b.batchNo,
          expiryDate: b.expiryDate,
          daysToExpiry: Math.floor((b.expiryDate.getTime() - now) / DAY),
          donor: b.donor?.name || "Unknown",
          status: b.heldAt ? "On hold" : "Available",
          boxes: 0,
          units: 0,
          value: 0,
          currency: null,
          valueMissing: false,
        });
      }
      const g = groups.get(key);
      g.boxes += 1;
      g.units += b.sachetsRemaining;
      const v = boxValueFor(b, b.sachetsRemaining);
      g.currency = g.currency || v.currency;
      if (v.value == null) g.valueMissing = true;
      else g.value += v.value;
    }
    const rows = [...groups.values()]
      .map((g) => ({ ...g, value: g.valueMissing && !g.value ? null : Number(g.value.toFixed(2)) }))
      .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.product.localeCompare(b.product) || a.expiryDate - b.expiryDate);
    const money = {};
    rows.forEach((r) => addMoney(money, r.currency, r.value));
    return {
      columns: [
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "batchNo", label: "Batch", type: "text" },
        { key: "expiryDate", label: "Expiry", type: "date" },
        { key: "daysToExpiry", label: "Days to expiry", type: "number" },
        { key: "donor", label: "Donor", type: "text" },
        { key: "status", label: "Status", type: "text" },
        { key: "boxes", label: "Boxes", type: "number" },
        { key: "units", label: "Units", type: "number" },
        { key: "value", label: "Value", type: "money" },
        { key: "currency", label: "Currency", type: "text" },
      ],
      rows,
      totals: { boxes: sumBy(rows, "boxes"), units: sumBy(rows, "units"), value: moneyLabel(roundMoney(money)) },
      notes: rows.some((r) => r.value === null) ? ["Some stock has no price (no PO line or batch valuation), so its value is blank."] : [],
    };
  },

  async "stock-movement"(req, ctx) {
    const { from, to } = periodFrom(req);
    const productFilter = req.query.productId ? Prisma.sql`AND b.productId = ${String(req.query.productId)}` : Prisma.empty;
    const donorFilter = req.query.donorId ? Prisma.sql`AND b.donorId = ${String(req.query.donorId)}` : Prisma.empty;
    const ids = Prisma.join(ctx.ids);
    const agg = (type, col) => prisma.$queryRaw`
      SELECT e.${Prisma.raw(col)} AS warehouseId, b.productId AS productId,
             SUM(CASE WHEN e.createdAt < ${from} THEN 1 ELSE 0 END) AS beforeBoxes,
             SUM(CASE WHEN e.createdAt < ${from} THEN b.sachetsPerBox ELSE 0 END) AS beforeUnits,
             SUM(CASE WHEN e.createdAt >= ${from} THEN 1 ELSE 0 END) AS periodBoxes,
             SUM(CASE WHEN e.createdAt >= ${from} THEN b.sachetsPerBox ELSE 0 END) AS periodUnits
      FROM \`BoxEvent\` e JOIN \`Box\` b ON b.id = e.boxId
      WHERE e.type = ${type} AND e.${Prisma.raw(col)} IN (${ids}) AND e.createdAt <= ${to} ${productFilter} ${donorFilter}
      GROUP BY e.${Prisma.raw(col)}, b.productId`;
    const [ins, outs, losses] = await Promise.all([
      agg("WAREHOUSE_RECEIVE", "toFacilityId"),
      agg("DISPATCH", "fromFacilityId"),
      prisma.$queryRaw`
        SELECT a.warehouseId AS warehouseId, l.productId AS productId,
               SUM(CASE WHEN a.decidedAt < ${from} AND l.fullBox THEN 1 ELSE 0 END) AS beforeBoxes,
               SUM(CASE WHEN a.decidedAt < ${from} THEN l.unitsWrittenOff ELSE 0 END) AS beforeUnits,
               SUM(CASE WHEN a.decidedAt >= ${from} AND l.fullBox THEN 1 ELSE 0 END) AS periodBoxes,
               SUM(CASE WHEN a.decidedAt >= ${from} THEN l.unitsWrittenOff ELSE 0 END) AS periodUnits
        FROM \`StockAdjustmentLine\` l JOIN \`StockAdjustment\` a ON a.id = l.adjustmentId
        WHERE a.status = 'APPROVED' AND a.warehouseId IN (${ids}) AND a.decidedAt <= ${to}
          ${req.query.productId ? Prisma.sql`AND l.productId = ${String(req.query.productId)}` : Prisma.empty}
          ${req.query.donorId ? Prisma.sql`AND l.donorId = ${String(req.query.donorId)}` : Prisma.empty}
        GROUP BY a.warehouseId, l.productId`,
    ]);
    const productIds = [...new Set([...ins, ...outs, ...losses].map((r) => r.productId))];
    const products = await prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } });
    const pName = new Map(products.map((p) => [p.id, p.name]));
    const rowsMap = new Map();
    const row = (w, p) => {
      const key = `${w}|${p}`;
      if (!rowsMap.has(key)) {
        rowsMap.set(key, { warehouse: ctx.byId.get(w)?.name, product: pName.get(p) || p, openingBoxes: 0, receivedBoxes: 0, dispatchedBoxes: 0, writtenOffBoxes: 0, openingUnits: 0, receivedUnits: 0, dispatchedUnits: 0, writtenOffUnits: 0 });
      }
      return rowsMap.get(key);
    };
    const n = (v) => Number(v || 0);
    for (const r of ins) {
      const x = row(r.warehouseId, r.productId);
      x.openingBoxes += n(r.beforeBoxes);
      x.openingUnits += n(r.beforeUnits);
      x.receivedBoxes += n(r.periodBoxes);
      x.receivedUnits += n(r.periodUnits);
    }
    for (const r of outs) {
      const x = row(r.warehouseId, r.productId);
      x.openingBoxes -= n(r.beforeBoxes);
      x.openingUnits -= n(r.beforeUnits);
      x.dispatchedBoxes += n(r.periodBoxes);
      x.dispatchedUnits += n(r.periodUnits);
    }
    for (const r of losses) {
      const x = row(r.warehouseId, r.productId);
      x.openingBoxes -= n(r.beforeBoxes);
      x.openingUnits -= n(r.beforeUnits);
      x.writtenOffBoxes += n(r.periodBoxes);
      x.writtenOffUnits += n(r.periodUnits);
    }
    const rows = [...rowsMap.values()]
      .map((x) => ({
        ...x,
        closingBoxes: x.openingBoxes + x.receivedBoxes - x.dispatchedBoxes - x.writtenOffBoxes,
        closingUnits: x.openingUnits + x.receivedUnits - x.dispatchedUnits - x.writtenOffUnits,
      }))
      .filter((x) => x.openingBoxes || x.receivedBoxes || x.dispatchedBoxes || x.writtenOffBoxes || x.writtenOffUnits || x.closingBoxes)
      .sort((a, b) => a.warehouse.localeCompare(b.warehouse) || a.product.localeCompare(b.product));
    const keys = ["openingBoxes", "receivedBoxes", "dispatchedBoxes", "writtenOffBoxes", "closingBoxes", "openingUnits", "receivedUnits", "dispatchedUnits", "writtenOffUnits", "closingUnits"];
    return {
      period: { from, to },
      columns: [
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "openingBoxes", label: "Opening (boxes)", type: "number" },
        { key: "receivedBoxes", label: "Received", type: "number" },
        { key: "dispatchedBoxes", label: "Dispatched", type: "number" },
        { key: "writtenOffBoxes", label: "Written off", type: "number" },
        { key: "closingBoxes", label: "Closing (boxes)", type: "number" },
        { key: "openingUnits", label: "Opening (units)", type: "number" },
        { key: "receivedUnits", label: "Received (units)", type: "number" },
        { key: "dispatchedUnits", label: "Dispatched (units)", type: "number" },
        { key: "writtenOffUnits", label: "Written off (units)", type: "number" },
        { key: "closingUnits", label: "Closing (units)", type: "number" },
      ],
      rows,
      totals: Object.fromEntries(keys.map((k) => [k, sumBy(rows, k)])),
      notes: [
        "Balances are counted in full boxes as received and dispatched; units are the box pack size.",
        "Written off = approved write-offs (expired, damaged, lost, count shortages). A partly damaged box reduces units but stays in the box count.",
        "Transfers between two warehouses appear as dispatched at one and received at the other.",
      ],
    };
  },

  async "daily-activity"(req, ctx) {
    const { from, to } = periodFrom(req);
    const ids = Prisma.join(ctx.ids);
    const [ins, outs, offs] = await Promise.all([
      prisma.$queryRaw`
        SELECT DATE(e.createdAt) AS day, e.toFacilityId AS warehouseId, COUNT(*) AS boxes,
               COUNT(DISTINCT COALESCE(b.goodsReceiptId, CONCAT(b.orderId, DATE_FORMAT(e.createdAt, '%Y%m%d%H%i')))) AS receipts,
               SUM(CASE WHEN e.fromFacilityId IS NOT NULL THEN 1 ELSE 0 END) AS transferBoxes
        FROM \`BoxEvent\` e JOIN \`Box\` b ON b.id = e.boxId
        WHERE e.type = 'WAREHOUSE_RECEIVE' AND e.toFacilityId IN (${ids}) AND e.createdAt BETWEEN ${from} AND ${to}
        GROUP BY DATE(e.createdAt), e.toFacilityId`,
      prisma.$queryRaw`
        SELECT DATE(s.dispatchedAt) AS day, s.fromWarehouseId AS warehouseId, COUNT(DISTINCT s.id) AS shipments, COUNT(i.id) AS boxes
        FROM \`Shipment\` s LEFT JOIN \`ShipmentItem\` i ON i.shipmentId = s.id
        WHERE s.fromWarehouseId IN (${ids}) AND s.dispatchedAt BETWEEN ${from} AND ${to} AND s.status <> 'CANCELLED'
        GROUP BY DATE(s.dispatchedAt), s.fromWarehouseId`,
      prisma.$queryRaw`
        SELECT DATE(a.decidedAt) AS day, a.warehouseId AS warehouseId, COUNT(DISTINCT a.id) AS adjustments, SUM(CASE WHEN l.fullBox THEN 1 ELSE 0 END) AS boxes
        FROM \`StockAdjustment\` a JOIN \`StockAdjustmentLine\` l ON l.adjustmentId = a.id
        WHERE a.status = 'APPROVED' AND a.warehouseId IN (${ids}) AND a.decidedAt BETWEEN ${from} AND ${to}
        GROUP BY DATE(a.decidedAt), a.warehouseId`,
    ]);
    const map = new Map();
    const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const row = (d, w) => {
      const key = `${dayKey(d)}|${w}`;
      if (!map.has(key)) map.set(key, { date: dayKey(d), warehouse: ctx.byId.get(w)?.name, receipts: 0, boxesReceived: 0, transferBoxesIn: 0, shipments: 0, boxesDispatched: 0, boxesWrittenOff: 0 });
      return map.get(key);
    };
    for (const r of ins) {
      const x = row(r.day, r.warehouseId);
      x.receipts += Number(r.receipts);
      x.boxesReceived += Number(r.boxes);
      x.transferBoxesIn += Number(r.transferBoxes);
    }
    for (const r of outs) {
      const x = row(r.day, r.warehouseId);
      x.shipments += Number(r.shipments);
      x.boxesDispatched += Number(r.boxes);
    }
    for (const r of offs) row(r.day, r.warehouseId).boxesWrittenOff += Number(r.boxes);
    const rows = [...map.values()].map((x) => ({ ...x, net: x.boxesReceived - x.boxesDispatched - x.boxesWrittenOff })).sort((a, b) => b.date.localeCompare(a.date) || a.warehouse.localeCompare(b.warehouse));
    return {
      period: { from, to },
      columns: [
        { key: "date", label: "Date", type: "date" },
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "receipts", label: "Deliveries received", type: "number" },
        { key: "boxesReceived", label: "Boxes received", type: "number" },
        { key: "transferBoxesIn", label: "of which transfers in", type: "number" },
        { key: "shipments", label: "Shipments sent", type: "number" },
        { key: "boxesDispatched", label: "Boxes dispatched", type: "number" },
        { key: "boxesWrittenOff", label: "Boxes written off", type: "number" },
        { key: "net", label: "Net change", type: "number" },
      ],
      rows,
      totals: Object.fromEntries(["receipts", "boxesReceived", "transferBoxesIn", "shipments", "boxesDispatched", "boxesWrittenOff", "net"].map((k) => [k, sumBy(rows, k)])),
      notes: [],
    };
  },

  async "activity-log"(req, ctx) {
    const { from, to } = periodFrom(req);
    const ids = ctx.ids;
    const [receipts, sent, received, legacy, adjustments, counts] = await Promise.all([
      prisma.goodsReceipt.findMany({
        where: { warehouseId: { in: ids }, receivedAt: { gte: from, lte: to } },
        include: {
          purchaseOrder: { select: { poNumber: true, supplierName: true } },
          receivedBy: { select: { fullName: true } },
          _count: { select: { boxes: true } },
        },
      }),
      prisma.shipment.findMany({
        where: { fromWarehouseId: { in: ids }, dispatchedAt: { gte: from, lte: to } },
        include: { toFacility: { select: { name: true } }, dispatchedBy: { select: { fullName: true } }, _count: { select: { items: true } } },
      }),
      prisma.shipment.findMany({
        where: { toFacilityId: { in: ids }, receivedAt: { gte: from, lte: to } },
        include: { fromWarehouse: { select: { name: true } }, receivedBy: { select: { fullName: true } }, _count: { select: { items: true } } },
      }),
      // Stock entered with Generate Boxes (no PO), grouped per order, user and minute.
      prisma.$queryRaw`
        SELECT MIN(e.createdAt) AS at, e.toFacilityId AS warehouseId, o.orderNumber AS orderNumber, o.donorName AS donorName,
               u.fullName AS userName, COUNT(*) AS boxes
        FROM \`BoxEvent\` e JOIN \`Box\` b ON b.id = e.boxId JOIN \`Order\` o ON o.id = b.orderId JOIN \`User\` u ON u.id = e.performedByUserId
        WHERE e.type = 'QR_CREATED' AND b.goodsReceiptId IS NULL AND e.toFacilityId IN (${Prisma.join(ids)}) AND e.createdAt BETWEEN ${from} AND ${to}
        GROUP BY e.toFacilityId, o.orderNumber, o.donorName, u.fullName, DATE_FORMAT(e.createdAt, '%Y%m%d%H%i')`,
      prisma.stockAdjustment.findMany({
        where: { warehouseId: { in: ids }, OR: [{ requestedAt: { gte: from, lte: to } }, { decidedAt: { gte: from, lte: to } }] },
        include: { requestedBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } }, _count: { select: { lines: true } } },
      }),
      prisma.stockCount.findMany({
        where: { warehouseId: { in: ids }, startedAt: { lte: to }, OR: [{ startedAt: { gte: from } }, { submittedAt: { gte: from, lte: to } }] },
        include: { startedBy: { select: { fullName: true } }, submittedBy: { select: { fullName: true } }, lines: { select: { expectedBoxes: true, countedBoxes: true } } },
      }),
    ]);
    const rows = [
      ...receipts.map((r) => ({
        at: r.receivedAt,
        warehouse: ctx.byId.get(r.warehouseId)?.name,
        activity: "Goods received (PO)",
        reference: `${r.grnNumber} · ${r.purchaseOrder.poNumber}`,
        counterpart: r.purchaseOrder.supplierName || "Supplier",
        boxes: r._count.boxes,
        by: r.receivedBy.fullName,
        detail: [r.deliveryNote ? `Delivery note ${r.deliveryNote}` : null, r.waybillNo ? `Waybill ${r.waybillNo}` : null].filter(Boolean).join(" · "),
      })),
      ...sent.map((s) => ({
        at: s.dispatchedAt,
        warehouse: ctx.byId.get(s.fromWarehouseId)?.name,
        activity: s.status === "CANCELLED" ? "Dispatch (cancelled)" : "Dispatched",
        reference: s.manifestNo,
        counterpart: s.toFacility.name,
        boxes: s._count.items,
        by: s.dispatchedBy.fullName,
        detail: s.status === "RECEIVED" ? `Received ${s.receivedAt ? s.receivedAt.toISOString().slice(0, 10) : ""}` : s.status === "DISPATCHED" ? "In transit" : "",
      })),
      ...received.map((s) => ({
        at: s.receivedAt,
        warehouse: ctx.byId.get(s.toFacilityId)?.name,
        activity: "Transfer received",
        reference: s.manifestNo,
        counterpart: s.fromWarehouse.name,
        boxes: s._count.items,
        by: s.receivedBy?.fullName || "",
        detail: "",
      })),
      ...legacy.map((l) => ({
        at: l.at,
        warehouse: ctx.byId.get(l.warehouseId)?.name,
        activity: "Boxes generated",
        reference: l.orderNumber,
        counterpart: l.donorName || "",
        boxes: Number(l.boxes),
        by: l.userName,
        detail: "Entered without a purchase order",
      })),
      ...adjustments.flatMap((a) => {
        const reason = a.reason.toLowerCase().replace("_", " ");
        const out = [];
        if (a.requestedAt >= from && a.requestedAt <= to) {
          out.push({ at: a.requestedAt, warehouse: ctx.byId.get(a.warehouseId)?.name, activity: "Write-off requested", reference: a.adjustmentNumber, counterpart: reason, boxes: a._count.lines, by: a.requestedBy.fullName, detail: a.note || "" });
        }
        if (a.decidedAt && a.decidedAt >= from && a.decidedAt <= to) {
          const label = { APPROVED: "Write-off approved", REJECTED: "Write-off rejected", CANCELLED: "Write-off cancelled" }[a.status] || a.status;
          out.push({ at: a.decidedAt, warehouse: ctx.byId.get(a.warehouseId)?.name, activity: label, reference: a.adjustmentNumber, counterpart: reason, boxes: a._count.lines, by: a.decidedBy?.fullName || "", detail: a.decisionNote || "" });
        }
        return out;
      }),
      ...counts.flatMap((c) => {
        const out = [];
        if (c.startedAt >= from) {
          out.push({ at: c.startedAt, warehouse: ctx.byId.get(c.warehouseId)?.name, activity: "Stock count started", reference: c.countNumber, counterpart: "", boxes: c.lines.reduce((s, l) => s + l.expectedBoxes, 0), by: c.startedBy.fullName, detail: `${c.lines.length} batch lines` });
        }
        if (c.submittedAt && c.submittedAt >= from && c.submittedAt <= to) {
          const short = c.lines.reduce((s, l) => s + Math.max(0, l.expectedBoxes - (l.countedBoxes ?? l.expectedBoxes)), 0);
          const surplus = c.lines.reduce((s, l) => s + Math.max(0, (l.countedBoxes ?? 0) - l.expectedBoxes), 0);
          out.push({
            at: c.submittedAt,
            warehouse: ctx.byId.get(c.warehouseId)?.name,
            activity: c.status === "CANCELLED" ? "Stock count cancelled" : "Stock count submitted",
            reference: c.countNumber,
            counterpart: "",
            boxes: c.lines.reduce((s, l) => s + (l.countedBoxes || 0), 0),
            by: c.submittedBy?.fullName || "",
            detail: c.status === "CANCELLED" ? "" : `${short} short, ${surplus} surplus`,
          });
        }
        return out;
      }),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));
    return {
      period: { from, to },
      columns: [
        { key: "at", label: "When", type: "datetime" },
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "activity", label: "Activity", type: "text" },
        { key: "reference", label: "Reference", type: "text" },
        { key: "counterpart", label: "From / to", type: "text" },
        { key: "boxes", label: "Boxes", type: "number" },
        { key: "by", label: "By", type: "text" },
        { key: "detail", label: "Detail", type: "text" },
      ],
      rows,
      totals: { boxes: null },
      notes: [],
    };
  },

  async "donor-summary"(req, ctx) {
    const { from, to } = periodFrom(req);
    const donorWhere = req.query.donorId ? { donorId: String(req.query.donorId) } : {};
    const productWhere = req.query.productId ? { productId: String(req.query.productId) } : {};
    const boxSelect = { ...BOX_VALUE_SELECT, productId: true, donor: { select: { id: true, name: true } }, product: { select: productValueSelect() } };
    const [stock, receivedEvents, dispatchEvents] = await Promise.all([
      prisma.box.findMany({ where: { status: "IN_WAREHOUSE", currentFacilityId: { in: ctx.ids }, ...donorWhere, ...productWhere }, select: boxSelect }),
      prisma.boxEvent.findMany({
        where: { type: "WAREHOUSE_RECEIVE", toFacilityId: { in: ctx.ids }, fromFacilityId: null, createdAt: { gte: from, lte: to }, box: { ...donorWhere, ...productWhere } },
        select: { box: { select: boxSelect } },
      }),
      prisma.boxEvent.findMany({
        where: { type: "DISPATCH", fromFacilityId: { in: ctx.ids }, createdAt: { gte: from, lte: to }, box: { ...donorWhere, ...productWhere } },
        select: { toFacilityId: true, box: { select: boxSelect } },
      }),
    ]);
    const scopeSet = new Set(ctx.ids);
    const map = new Map();
    const row = (b) => {
      const key = `${b.donor?.id || "none"}|${b.productId}`;
      if (!map.has(key)) {
        map.set(key, { donor: b.donor?.name || "Unknown donor", product: b.product.name, receivedBoxes: 0, receivedValue: 0, dispatchedBoxes: 0, dispatchedValue: 0, stockBoxes: 0, stockUnits: 0, stockValue: 0, unpricedBoxes: 0, currency: null });
      }
      return map.get(key);
    };
    const add = (x, field, v) => {
      if (v.value != null) x[field] += v.value;
      x.currency = x.currency || v.currency;
    };
    for (const e of receivedEvents) {
      const x = row(e.box);
      x.receivedBoxes += 1;
      add(x, "receivedValue", boxValueFor(e.box, e.box.sachetsPerBox));
    }
    for (const e of dispatchEvents) {
      // Transfers to another warehouse in scope are internal moves, not dispatches.
      if (scopeSet.has(e.toFacilityId)) continue;
      const x = row(e.box);
      x.dispatchedBoxes += 1;
      add(x, "dispatchedValue", boxValueFor(e.box, e.box.sachetsPerBox));
    }
    for (const b of stock) {
      const x = row(b);
      x.stockBoxes += 1;
      x.stockUnits += b.sachetsRemaining;
      const v = boxValueFor(b, b.sachetsRemaining);
      if (v.value == null) x.unpricedBoxes += 1;
      add(x, "stockValue", v);
    }
    const rows = [...map.values()]
      .map((x) => ({ ...x, receivedValue: Number(x.receivedValue.toFixed(2)), dispatchedValue: Number(x.dispatchedValue.toFixed(2)), stockValue: Number(x.stockValue.toFixed(2)) }))
      .sort((a, b) => a.donor.localeCompare(b.donor) || a.product.localeCompare(b.product));
    const totalMoney = (field) => {
      const m = {};
      rows.forEach((r) => addMoney(m, r.currency, r[field]));
      return moneyLabel(roundMoney(m));
    };
    return {
      period: { from, to },
      columns: [
        { key: "donor", label: "Donor", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "receivedBoxes", label: "Received (boxes)", type: "number" },
        { key: "receivedValue", label: "Received value", type: "money" },
        { key: "dispatchedBoxes", label: "Dispatched (boxes)", type: "number" },
        { key: "dispatchedValue", label: "Dispatched value", type: "money" },
        { key: "stockBoxes", label: "In stock (boxes)", type: "number" },
        { key: "stockUnits", label: "In stock (units)", type: "number" },
        { key: "stockValue", label: "Stock value", type: "money" },
        { key: "unpricedBoxes", label: "Boxes without price", type: "number" },
        { key: "currency", label: "Currency", type: "text" },
      ],
      rows,
      totals: {
        unpricedBoxes: sumBy(rows, "unpricedBoxes"),
        receivedBoxes: sumBy(rows, "receivedBoxes"),
        receivedValue: totalMoney("receivedValue"),
        dispatchedBoxes: sumBy(rows, "dispatchedBoxes"),
        dispatchedValue: totalMoney("dispatchedValue"),
        stockBoxes: sumBy(rows, "stockBoxes"),
        stockUnits: sumBy(rows, "stockUnits"),
        stockValue: totalMoney("stockValue"),
      },
      notes: [
        "Received counts new stock entering warehouses (purchase orders and generated boxes), not transfers between warehouses.",
        "Dispatched counts stock leaving the selected warehouses for sites or other warehouses outside the selection.",
        ...(rows.some((r) => r.unpricedBoxes)
          ? ["Some boxes have no price (entered without a purchase order and with no batch value), so values are understated; see \"Boxes without price\"."]
          : []),
      ],
    };
  },

  async expiry(req, ctx) {
    const days = Math.max(1, Math.min(3650, Number.parseInt(req.query.expiryDays || "180", 10) || 180));
    const limit = new Date(Date.now() + days * DAY);
    req.query.expiryLimit = limit;
    const base = await BUILDERS["stock-on-hand"](req, ctx);
    const rows = base.rows
      .filter((r) => r.expiryDate <= limit)
      .map((r) => ({ ...r, band: r.daysToExpiry < 0 ? "Expired" : r.daysToExpiry <= 60 ? "Under 60 days" : r.daysToExpiry <= 120 ? "60–120 days" : `Under ${days} days` }))
      .sort((a, b) => a.expiryDate - b.expiryDate);
    const money = {};
    rows.forEach((r) => addMoney(money, r.currency, r.value));
    return {
      columns: [
        { key: "band", label: "Risk", type: "text" },
        ...base.columns.filter((c) => c.key !== "currency"),
        { key: "currency", label: "Currency", type: "text" },
      ],
      rows,
      totals: { boxes: sumBy(rows, "boxes"), units: sumBy(rows, "units"), value: moneyLabel(roundMoney(money)) },
      notes: [`Batches expired or expiring within ${days} days.`],
    };
  },

  async "purchase-orders"(req, ctx) {
    const { from, to } = periodFrom(req);
    const where = {
      destinationWarehouseId: { in: ctx.ids },
      OR: [{ createdAt: { gte: from, lte: to } }, { status: { in: ["OPEN", "PARTIALLY_RECEIVED"] } }],
    };
    if (req.query.donorId) where.lines = { some: { donorId: String(req.query.donorId) } };
    const pos = await prisma.purchaseOrder.findMany({
      where,
      include: { lines: { include: { donor: { select: { name: true } } } }, receipts: { select: { receivedAt: true }, orderBy: { receivedAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" },
    });
    const now = Date.now();
    const rows = pos.map((po) => {
      const ordered = sumBy(po.lines, "quantityPacks");
      const received = sumBy(po.lines, "receivedPacks");
      const value = po.lines.reduce((s, l) => s + Number(l.unitPrice) * l.quantityPacks, 0);
      const receivedValue = po.lines.reduce((s, l) => s + Number(l.unitPrice) * l.receivedPacks, 0);
      const open = ["OPEN", "PARTIALLY_RECEIVED"].includes(po.status);
      return {
        poNumber: po.poNumber,
        supplier: po.supplierName || "",
        warehouse: ctx.byId.get(po.destinationWarehouseId)?.name,
        donors: [...new Set(po.lines.map((l) => l.donor.name))].join(", "),
        status: po.status.replace("_", " ").toLowerCase(),
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        lastReceivedAt: po.receipts[0]?.receivedAt || null,
        ordered,
        received,
        outstanding: Math.max(0, ordered - received),
        percentReceived: ordered ? Math.round((received / ordered) * 100) : 0,
        value: Number(value.toFixed(2)),
        receivedValue: Number(receivedValue.toFixed(2)),
        currency: po.currencyCode,
        overdue: open && po.expectedDeliveryDate && po.expectedDeliveryDate.getTime() < now ? "Yes" : "",
      };
    });
    const m = {};
    const rm = {};
    rows.forEach((r) => {
      addMoney(m, r.currency, r.value);
      addMoney(rm, r.currency, r.receivedValue);
    });
    return {
      period: { from, to },
      columns: [
        { key: "poNumber", label: "PO number", type: "text" },
        { key: "supplier", label: "Supplier", type: "text" },
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "donors", label: "Donor(s)", type: "text" },
        { key: "status", label: "Status", type: "text" },
        { key: "orderDate", label: "Order date", type: "date" },
        { key: "expectedDeliveryDate", label: "Expected", type: "date" },
        { key: "lastReceivedAt", label: "Last delivery", type: "date" },
        { key: "ordered", label: "Ordered (packs)", type: "number" },
        { key: "received", label: "Received", type: "number" },
        { key: "outstanding", label: "Outstanding", type: "number" },
        { key: "percentReceived", label: "% received", type: "percent" },
        { key: "value", label: "PO value", type: "money" },
        { key: "receivedValue", label: "Received value", type: "money" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "overdue", label: "Overdue", type: "text" },
      ],
      rows,
      totals: {
        ordered: sumBy(rows, "ordered"),
        received: sumBy(rows, "received"),
        outstanding: sumBy(rows, "outstanding"),
        value: moneyLabel(roundMoney(m)),
        receivedValue: moneyLabel(roundMoney(rm)),
      },
      notes: ["Shows POs created in the period plus every PO still open."],
    };
  },

  async dispatches(req, ctx) {
    const { from, to } = periodFrom(req);
    const shipments = await prisma.shipment.findMany({
      where: { fromWarehouseId: { in: ctx.ids }, dispatchedAt: { gte: from, lte: to } },
      include: {
        toFacility: { select: { name: true, type: true } },
        dispatchedBy: { select: { fullName: true } },
        items: { select: { box: { select: { ...BOX_VALUE_SELECT, product: { select: productValueSelect() } } } } },
      },
      orderBy: { dispatchedAt: "desc" },
    });
    const now = Date.now();
    const rows = shipments.map((s) => {
      const money = {};
      let units = 0;
      for (const i of s.items) {
        units += i.box.sachetsPerBox;
        const v = boxValueFor(i.box, i.box.sachetsPerBox);
        addMoney(money, v.currency, v.value);
      }
      const entries = Object.entries(roundMoney(money));
      const end = s.receivedAt ? s.receivedAt.getTime() : now;
      return {
        dispatchedAt: s.dispatchedAt,
        manifestNo: s.manifestNo,
        from: ctx.byId.get(s.fromWarehouseId)?.name,
        to: s.toFacility.name,
        destinationType: s.toFacility.type === "WAREHOUSE" ? "Warehouse" : "Site",
        boxes: s.items.length,
        units,
        value: entries.length === 1 ? entries[0][1] : null,
        currency: entries.map(([c]) => c).join("/"),
        status: s.status.toLowerCase(),
        receivedAt: s.receivedAt,
        daysInTransit: Math.floor((end - s.dispatchedAt.getTime()) / DAY),
        by: s.dispatchedBy.fullName,
      };
    });
    const m = {};
    rows.forEach((r) => addMoney(m, r.currency, r.value));
    return {
      period: { from, to },
      columns: [
        { key: "dispatchedAt", label: "Dispatched", type: "datetime" },
        { key: "manifestNo", label: "Manifest", type: "text" },
        { key: "from", label: "From", type: "text" },
        { key: "to", label: "To", type: "text" },
        { key: "destinationType", label: "Type", type: "text" },
        { key: "boxes", label: "Boxes", type: "number" },
        { key: "units", label: "Units", type: "number" },
        { key: "value", label: "Value", type: "money" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "status", label: "Status", type: "text" },
        { key: "receivedAt", label: "Received", type: "date" },
        { key: "daysInTransit", label: "Days in transit", type: "number" },
        { key: "by", label: "Dispatched by", type: "text" },
      ],
      rows,
      totals: { boxes: sumBy(rows, "boxes"), units: sumBy(rows, "units"), value: moneyLabel(roundMoney(m)) },
      notes: [],
    };
  },

  async losses(req, ctx) {
    const { from, to } = periodFrom(req);
    const where = { adjustment: { status: "APPROVED", warehouseId: { in: ctx.ids }, decidedAt: { gte: from, lte: to } } };
    if (req.query.donorId) where.donorId = String(req.query.donorId);
    if (req.query.productId) where.productId = String(req.query.productId);
    const lines = await prisma.stockAdjustmentLine.findMany({
      where,
      include: {
        adjustment: {
          select: { adjustmentNumber: true, reason: true, warehouseId: true, decidedAt: true, requestedBy: { select: { fullName: true } }, decidedBy: { select: { fullName: true } } },
        },
      },
    });
    const [products, donors] = await Promise.all([
      prisma.product.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.productId))] } }, select: { id: true, name: true } }),
      prisma.donor.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.donorId).filter(Boolean))] } }, select: { id: true, name: true } }),
    ]);
    const pName = new Map(products.map((p) => [p.id, p.name]));
    const dName = new Map(donors.map((d) => [d.id, d.name]));
    const map = new Map();
    for (const l of lines) {
      const a = l.adjustment;
      const key = [a.adjustmentNumber, l.productId, l.batchNo, l.donorId || ""].join("|");
      if (!map.has(key)) {
        map.set(key, {
          date: a.decidedAt,
          reference: a.adjustmentNumber,
          warehouse: ctx.byId.get(a.warehouseId)?.name,
          reason: a.reason.toLowerCase().replace("_", " "),
          product: pName.get(l.productId) || l.productId,
          batchNo: l.batchNo,
          expiryDate: l.expiryDate,
          donor: l.donorId ? dName.get(l.donorId) || "Unknown donor" : "Unknown donor",
          boxes: 0,
          units: 0,
          value: 0,
          valueMissing: false,
          currency: l.currencyCode || null,
          requestedBy: a.requestedBy.fullName,
          approvedBy: a.decidedBy?.fullName || "",
        });
      }
      const x = map.get(key);
      if (l.fullBox) x.boxes += 1;
      x.units += l.unitsWrittenOff;
      if (l.unitValue == null) x.valueMissing = true;
      else x.value += Number(l.unitValue) * l.unitsWrittenOff;
    }
    const rows = [...map.values()]
      .map((x) => ({ ...x, value: x.valueMissing && !x.value ? null : Number(x.value.toFixed(2)) }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const money = {};
    rows.forEach((r) => addMoney(money, r.currency, r.value));
    const byReason = {};
    rows.forEach((r) => (byReason[r.reason] = (byReason[r.reason] || 0) + r.units));
    return {
      period: { from, to },
      columns: [
        { key: "date", label: "Approved", type: "date" },
        { key: "reference", label: "Reference", type: "text" },
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "reason", label: "Reason", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "batchNo", label: "Batch", type: "text" },
        { key: "expiryDate", label: "Expiry", type: "date" },
        { key: "donor", label: "Donor", type: "text" },
        { key: "boxes", label: "Boxes removed", type: "number" },
        { key: "units", label: "Units lost", type: "number" },
        { key: "value", label: "Value lost", type: "money" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "requestedBy", label: "Requested by", type: "text" },
        { key: "approvedBy", label: "Approved by", type: "text" },
      ],
      rows,
      totals: { boxes: sumBy(rows, "boxes"), units: sumBy(rows, "units"), value: moneyLabel(roundMoney(money)) },
      notes: Object.keys(byReason).length
        ? [`Units lost by reason: ${Object.entries(byReason).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(", ")}.`]
        : [],
    };
  },

  async "stock-counts"(req, ctx) {
    const { from, to } = periodFrom(req);
    const counts = await prisma.stockCount.findMany({
      where: { warehouseId: { in: ctx.ids }, status: "SUBMITTED", submittedAt: { gte: from, lte: to } },
      include: { lines: true, submittedBy: { select: { fullName: true } }, adjustment: { select: { adjustmentNumber: true, status: true } } },
      orderBy: { submittedAt: "desc" },
    });
    const productIds = [...new Set(counts.flatMap((c) => c.lines.map((l) => l.productId)))];
    const donorIds = [...new Set(counts.flatMap((c) => c.lines.map((l) => l.donorId)).filter(Boolean))];
    const [products, donors] = await Promise.all([
      prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } }),
      prisma.donor.findMany({ where: { id: { in: donorIds } }, select: { id: true, name: true } }),
    ]);
    const pName = new Map(products.map((p) => [p.id, p.name]));
    const dName = new Map(donors.map((d) => [d.id, d.name]));
    const rows = counts.flatMap((c) =>
      c.lines
        .filter((l) => !req.query.productId || l.productId === String(req.query.productId))
        .map((l) => {
          const variance = (l.countedBoxes ?? 0) - l.expectedBoxes;
          return {
            date: c.submittedAt,
            count: c.countNumber,
            warehouse: ctx.byId.get(c.warehouseId)?.name,
            product: pName.get(l.productId) || l.productId,
            batchNo: l.batchNo,
            expiryDate: l.expiryDate,
            donor: l.donorId ? dName.get(l.donorId) || "Unknown donor" : "Unknown donor",
            expected: l.expectedBoxes,
            counted: l.countedBoxes ?? 0,
            variance,
            result: variance < 0 ? "Short" : variance > 0 ? (l.addedByCounter ? "Found (not in system)" : "Surplus") : "Match",
            writeOff: variance < 0 && c.adjustment ? `${c.adjustment.adjustmentNumber} (${c.adjustment.status.toLowerCase().replace("_", " ")})` : "",
            countedBy: c.submittedBy?.fullName || "",
          };
        })
    );
    const matched = rows.filter((r) => r.variance === 0).length;
    return {
      period: { from, to },
      columns: [
        { key: "date", label: "Submitted", type: "date" },
        { key: "count", label: "Count", type: "text" },
        { key: "warehouse", label: "Warehouse", type: "text" },
        { key: "product", label: "Product", type: "text" },
        { key: "batchNo", label: "Batch", type: "text" },
        { key: "expiryDate", label: "Expiry", type: "date" },
        { key: "donor", label: "Donor", type: "text" },
        { key: "expected", label: "Expected", type: "number" },
        { key: "counted", label: "Counted", type: "number" },
        { key: "variance", label: "Variance", type: "number" },
        { key: "result", label: "Result", type: "text" },
        { key: "writeOff", label: "Write-off", type: "text" },
        { key: "countedBy", label: "Submitted by", type: "text" },
      ],
      rows,
      totals: { expected: sumBy(rows, "expected"), counted: sumBy(rows, "counted"), variance: sumBy(rows, "variance") },
      notes: rows.length ? [`Accuracy: ${Math.round((matched / rows.length) * 100)}% of batch lines matched exactly.`] : [],
    };
  },
};

router.get("/", (req, res) => res.json({ reports: REPORTS }));

router.get("/:report", async (req, res) => {
  try {
    const meta = REPORTS.find((r) => r.key === req.params.report);
    if (!meta) return res.status(404).json({ message: "Unknown report" });
    const warehouses = await scopeWarehouses(req);
    const ctx = { ids: warehouses.map((w) => w.id), byId: new Map(warehouses.map((w) => [w.id, w])), warehouses };
    if (!ctx.ids.length) {
      return res.json({ report: meta.key, title: meta.title, description: meta.description, columns: [], rows: [], totals: {}, notes: ["No warehouses in your scope."] });
    }
    const out = await BUILDERS[meta.key](req, ctx);
    return res.json({
      report: meta.key,
      title: meta.title,
      description: meta.description,
      generatedAt: new Date(),
      warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })),
      ...out,
    });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
