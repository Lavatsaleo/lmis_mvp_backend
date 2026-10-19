// Warehouse digital twin: what is physically in a warehouse right now, how
// full it is, what is about to expire, what is arriving, how fast stock moves,
// and what to do about it. Warehouses only (not facility stores).
//
//   GET /api/warehouses                 warehouses the user can see + headline numbers
//   GET /api/warehouses/:id/twin        full picture of one warehouse (3D view + insights)
//
// Positions in the dashboard's 3D view are generated from this data (stock is
// grouped by product and batch, earliest expiry nearest the dispatch dock);
// they are illustrative, not real rack locations.

const express = require("express");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireModule } = require("../middleware/modules");
const { visibleWarehouseWhere, boxUnitValue, BOX_VALUE_SELECT, productValueSelect, addMoney, roundMoney } = require("../warehouse/common");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

// A standard pallet carries about a tonne. Used to turn boxes into pallets for
// the 3D view and capacity maths when a product has a pack weight.
const PALLET_MAX_KG = 1000;
const DEFAULT_BOXES_PER_PALLET = 40;
const MOVEMENT_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// Expiry bands, shared with the dashboard legend.
const EXPIRY_BANDS = [
  { key: "EXPIRED", maxDays: 0 },
  { key: "CRITICAL", maxDays: 60 },
  { key: "WARNING", maxDays: 120 },
  { key: "OK", maxDays: Infinity },
];

function expiryBand(daysToExpiry) {
  return EXPIRY_BANDS.find((b) => daysToExpiry <= b.maxDays).key;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const round = (n, d = 2) => Number(Number(n || 0).toFixed(d));

function packWeightKg(product) {
  const w = num(product?.grossPackWeightKg);
  return w && w > 0 ? w : null;
}

function boxesPerPallet(product) {
  // The supplier pallet configuration wins (from the packing list).
  if (product?.cartonsPerPallet) return product.cartonsPerPallet;
  const w = packWeightKg(product);
  if (!w) return DEFAULT_BOXES_PER_PALLET;
  return Math.max(4, Math.min(200, Math.floor(PALLET_MAX_KG / w)));
}

// Weight of what is left in a box (same basis as Inventory Intelligence:
// base units x pack weight / units per pack).
function boxWeightKg(box, product) {
  const w = packWeightKg(product);
  if (!w) return null;
  const perUnit = w / Math.max(1, product.unitsPerPack || box.sachetsPerBox || 1);
  return box.sachetsRemaining * perUnit;
}

// Access (visibleWarehouseWhere): SUPER_ADMIN everything; COUNTRY_ADMIN /
// country-wide VIEWER their country; anyone on a warehouse that warehouse and
// every warehouse below it. Facility users have no warehouse view.

// ---------------------------------------------------------------------------
// GET /api/warehouses
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const where = await visibleWarehouseWhere(req);
    if (!where) return res.json({ rows: [] });

    const warehouses = await prisma.facility.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        stockLocationType: true,
        capacityMetricTonnes: true,
        parentStockLocationId: true,
        implementationId: true,
        county: { select: { id: true, name: true } },
      },
      orderBy: [{ stockLocationType: "asc" }, { name: "asc" }],
    });
    const ids = warehouses.map((w) => w.id);
    if (!ids.length) return res.json({ rows: [] });

    const now = new Date();
    const soon = new Date(now.getTime() + 120 * DAY_MS);
    const [stock, expiring, expired, incoming, products] = await Promise.all([
      prisma.box.groupBy({
        // Per batch, so pallet counts match the twin (a pallet holds one batch).
        by: ["currentFacilityId", "productId", "batchNo", "expiryDate"],
        where: { status: "IN_WAREHOUSE", currentFacilityId: { in: ids } },
        _count: { _all: true },
        _sum: { sachetsRemaining: true },
      }),
      prisma.box.groupBy({
        by: ["currentFacilityId"],
        where: { status: "IN_WAREHOUSE", currentFacilityId: { in: ids }, expiryDate: { gt: now, lte: soon } },
        _count: { _all: true },
      }),
      prisma.box.groupBy({
        by: ["currentFacilityId"],
        where: { status: "IN_WAREHOUSE", currentFacilityId: { in: ids }, expiryDate: { lte: now } },
        _count: { _all: true },
      }),
      prisma.shipment.groupBy({
        by: ["toFacilityId"],
        where: { status: "DISPATCHED", toFacilityId: { in: ids } },
        _count: { _all: true },
      }),
      prisma.product.findMany({ select: { id: true, unitsPerPack: true, grossPackWeightKg: true, cartonsPerPallet: true } }),
    ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    const byWarehouse = new Map(ids.map((id) => [id, { boxes: 0, units: 0, weightKg: 0, weightKnown: true, pallets: 0 }]));
    for (const g of stock) {
      const b = byWarehouse.get(g.currentFacilityId);
      const product = productMap.get(g.productId);
      b.boxes += g._count._all;
      b.units += g._sum.sachetsRemaining || 0;
      b.pallets += Math.ceil(g._count._all / boxesPerPallet(product));
      const w = packWeightKg(product);
      if (w) b.weightKg += ((g._sum.sachetsRemaining || 0) * w) / Math.max(1, product.unitsPerPack || 1);
      else if (g._count._all) b.weightKnown = false;
    }
    const countMap = (rows, key) => new Map(rows.map((r) => [r[key], r._count._all]));
    const expiringMap = countMap(expiring, "currentFacilityId");
    const expiredMap = countMap(expired, "currentFacilityId");
    const incomingMap = countMap(incoming, "toFacilityId");

    const rows = warehouses.map((w) => {
      const s = byWarehouse.get(w.id);
      const capacity = num(w.capacityMetricTonnes);
      const tonnes = s.weightKg / 1000;
      return {
        ...w,
        capacityMetricTonnes: capacity,
        boxes: s.boxes,
        units: s.units,
        pallets: s.pallets,
        metricTonnes: s.weightKnown ? round(tonnes, 3) : null,
        utilisationPct: capacity && s.weightKnown ? round((tonnes / capacity) * 100, 1) : null,
        expiringBoxes: expiringMap.get(w.id) || 0,
        expiredBoxes: expiredMap.get(w.id) || 0,
        incomingShipments: incomingMap.get(w.id) || 0,
      };
    });
    return res.json({ rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/warehouses/:id/twin
// ---------------------------------------------------------------------------
router.get("/:id/twin", async (req, res) => {
  try {
    const where = await visibleWarehouseWhere(req);
    const warehouse = where
      ? await prisma.facility.findFirst({
          // AND, not a spread: the user's scope may itself filter on id.
          where: { AND: [where, { id: String(req.params.id) }] },
          include: {
            county: { select: { id: true, name: true } },
            parentStockLocation: { select: { id: true, code: true, name: true } },
            implementation: { select: { id: true, name: true, country: { select: { name: true, code: true } } } },
          },
        })
      : null;
    if (!warehouse) return res.status(404).json({ message: "Warehouse not found" });

    const now = new Date();
    const windowStart = new Date(now.getTime() - MOVEMENT_WINDOW_DAYS * DAY_MS);

    const [boxes, incomingShipments, outgoingShipments, receivedEvents, dispatchEvents, childWarehouses, lastReceive, lastDispatch] =
      await Promise.all([
        prisma.box.findMany({
          where: { status: "IN_WAREHOUSE", currentFacilityId: warehouse.id },
          select: {
            ...BOX_VALUE_SELECT,
            id: true,
            boxUid: true,
            expiryDate: true,
            createdAt: true,
            product: { select: productValueSelect() },
            donor: { select: { id: true, name: true } },
            order: { select: { orderNumber: true, donorName: true } },
            heldAt: true,
            holdReason: true,
            holdAdjustmentId: true,
          },
          orderBy: [{ expiryDate: "asc" }, { boxUid: "asc" }],
          take: 50000,
        }),
        prisma.shipment.findMany({
          where: { status: "DISPATCHED", toFacilityId: warehouse.id },
          orderBy: { dispatchedAt: "asc" },
          select: {
            id: true,
            manifestNo: true,
            dispatchedAt: true,
            fromWarehouse: { select: { id: true, code: true, name: true } },
            items: {
              where: { receivedAt: null },
              select: { box: { select: { sachetsRemaining: true, product: { select: { id: true, name: true } } } } },
            },
          },
        }),
        prisma.shipment.findMany({
          where: { status: "DISPATCHED", fromWarehouseId: warehouse.id },
          orderBy: { dispatchedAt: "asc" },
          select: {
            id: true,
            manifestNo: true,
            dispatchedAt: true,
            toFacility: { select: { id: true, code: true, name: true, type: true } },
            _count: { select: { items: true } },
          },
        }),
        prisma.boxEvent.findMany({
          where: { type: "WAREHOUSE_RECEIVE", toFacilityId: warehouse.id, createdAt: { gte: windowStart } },
          select: { createdAt: true, box: { select: { productId: true, sachetsPerBox: true } } },
        }),
        prisma.boxEvent.findMany({
          where: { type: "DISPATCH", fromFacilityId: warehouse.id, createdAt: { gte: windowStart } },
          select: { createdAt: true, toFacilityId: true, box: { select: { productId: true, sachetsPerBox: true } } },
        }),
        prisma.facility.findMany({
          where: { type: "WAREHOUSE", parentStockLocationId: warehouse.id },
          select: { id: true, code: true, name: true },
          orderBy: { name: "asc" },
        }),
        prisma.boxEvent.findFirst({
          where: { type: "WAREHOUSE_RECEIVE", toFacilityId: warehouse.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        prisma.boxEvent.findFirst({
          where: { type: "DISPATCH", fromFacilityId: warehouse.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
      ]);

    // Box IDs end in a running number: sort them naturally (…-2 before …-10)
    // within each expiry date, so pick lists read in label order.
    const collator = new Intl.Collator("en", { numeric: true });
    boxes.sort((a, b) => a.expiryDate - b.expiryDate || collator.compare(a.boxUid, b.boxUid));

    // ---- Movement: daily in/out over the window, and outflow rate per product
    const days = [];
    for (let i = MOVEMENT_WINDOW_DAYS - 1; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * DAY_MS);
      days.push({ date: d.toISOString().slice(0, 10), inBoxes: 0, outBoxes: 0 });
    }
    const dayIndex = new Map(days.map((d, i) => [d.date, i]));
    const outUnitsByProduct = new Map();
    const inUnitsByProduct = new Map();
    for (const e of receivedEvents) {
      const i = dayIndex.get(e.createdAt.toISOString().slice(0, 10));
      if (i !== undefined) days[i].inBoxes += 1;
      inUnitsByProduct.set(e.box.productId, (inUnitsByProduct.get(e.box.productId) || 0) + (e.box.sachetsPerBox || 0));
    }
    for (const e of dispatchEvents) {
      const i = dayIndex.get(e.createdAt.toISOString().slice(0, 10));
      if (i !== undefined) days[i].outBoxes += 1;
      outUnitsByProduct.set(e.box.productId, (outUnitsByProduct.get(e.box.productId) || 0) + (e.box.sachetsPerBox || 0));
    }

    // ---- Stock grouped product -> batch (one batch = one product + batch no + expiry)
    const productGroups = new Map();
    const batchGroups = new Map();
    let totalWeightKg = 0;
    let weightKnown = true;
    for (const box of boxes) {
      const p = box.product;
      if (!productGroups.has(p.id)) {
        productGroups.set(p.id, {
          product: { id: p.id, code: p.code, name: p.name, baseUnitName: p.baseUnitName, packUnitName: p.packUnitName },
          boxesPerPallet: boxesPerPallet(p),
          packWeightKg: packWeightKg(p),
          boxes: 0,
          units: 0,
          weightKg: 0,
        });
      }
      const pg = productGroups.get(p.id);
      const donorName = box.donor?.name || box.order?.donorName || "Unknown donor";
      // Held stock forms its own pallets (quarantine area).
      const key = `${p.id}|${box.batchNo}|${box.expiryDate.toISOString().slice(0, 10)}|${box.donor?.id || donorName}|${box.heldAt ? "held" : "ok"}`;
      if (!batchGroups.has(key)) {
        const daysToExpiry = Math.floor((box.expiryDate.getTime() - now.getTime()) / DAY_MS);
        batchGroups.set(key, {
          key,
          productId: p.id,
          productName: p.name,
          batchNo: box.batchNo,
          expiryDate: box.expiryDate,
          daysToExpiry,
          expiryBand: expiryBand(daysToExpiry),
          boxes: 0,
          units: 0,
          weightKg: 0,
          oldestInStockSince: box.createdAt,
          donorId: box.donor?.id || null,
          donorName,
          onHold: !!box.heldAt,
          holdReason: box.holdReason || null,
          pendingWriteOff: !!box.holdAdjustmentId,
          donors: new Set([donorName]),
          value: 0,
          valueKnown: true,
          currency: null,
          boxUids: [],
        });
      }
      const bg = batchGroups.get(key);
      const w = boxWeightKg(box, p);
      bg.boxes += 1;
      bg.units += box.sachetsRemaining;
      pg.boxes += 1;
      pg.units += box.sachetsRemaining;
      if (w === null) weightKnown = false;
      else {
        bg.weightKg += w;
        pg.weightKg += w;
        totalWeightKg += w;
      }
      if (box.createdAt < bg.oldestInStockSince) bg.oldestInStockSince = box.createdAt;
      const v = boxUnitValue(box);
      bg.currency = bg.currency || v.currencyCode;
      if (v.unitValue == null || !Number.isFinite(v.unitValue)) bg.valueKnown = false;
      else bg.value += v.unitValue * box.sachetsRemaining;
      if (bg.boxUids.length < 200) bg.boxUids.push(box.boxUid);
    }

    // Earliest expiry first: the order stock should leave the warehouse (FEFO).
    const batches = [...batchGroups.values()]
      .sort((a, b) => a.expiryDate - b.expiryDate || a.batchNo.localeCompare(b.batchNo))
      .map((b, i) => ({
        ...b,
        fefoRank: i + 1,
        weightKg: round(b.weightKg, 1),
        donors: [...b.donors],
        value: b.valueKnown || b.value ? round(b.value, 2) : null,
        pallets: Math.ceil(b.boxes / productGroups.get(b.productId).boxesPerPallet),
      }));

    // Who funded the stock in this warehouse, and what it is worth.
    const donorMap = new Map();
    const stockValue = {};
    for (const b of batches) {
      const k = b.donorId || b.donorName;
      if (!donorMap.has(k)) donorMap.set(k, { donorId: b.donorId, name: b.donorName, boxes: 0, units: 0, value: {}, batches: 0 });
      const d = donorMap.get(k);
      d.boxes += b.boxes;
      d.units += b.units;
      d.batches += 1;
      addMoney(d.value, b.currency, b.value);
      addMoney(stockValue, b.currency, b.value);
    }
    const donors = [...donorMap.values()]
      .map((d) => ({ ...d, value: roundMoney(d.value), share: boxes.length ? round((d.boxes / boxes.length) * 100, 1) : 0 }))
      .sort((a, b) => b.boxes - a.boxes);

    const products = [...productGroups.values()].map((pg) => {
      const outUnits = outUnitsByProduct.get(pg.product.id) || 0;
      const avgDailyOut = outUnits / MOVEMENT_WINDOW_DAYS;
      return {
        ...pg,
        weightKg: round(pg.weightKg, 1),
        avgDailyOutUnits: round(avgDailyOut, 1),
        receivedUnits90d: inUnitsByProduct.get(pg.product.id) || 0,
        dispatchedUnits90d: outUnits,
        daysOfCover: avgDailyOut > 0 ? round(pg.units / avgDailyOut, 0) : null,
      };
    });

    const incoming = incomingShipments
      .map((s) => ({
        id: s.id,
        manifestNo: s.manifestNo,
        dispatchedAt: s.dispatchedAt,
        daysInTransit: Math.floor((now.getTime() - s.dispatchedAt.getTime()) / DAY_MS),
        from: s.fromWarehouse,
        boxes: s.items.length,
        units: s.items.reduce((sum, i) => sum + (i.box?.sachetsRemaining || 0), 0),
        products: [...new Set(s.items.map((i) => i.box?.product?.name).filter(Boolean))],
      }))
      .filter((s) => s.boxes > 0);
    const outgoing = outgoingShipments.map((s) => ({
      id: s.id,
      manifestNo: s.manifestNo,
      dispatchedAt: s.dispatchedAt,
      daysInTransit: Math.floor((now.getTime() - s.dispatchedAt.getTime()) / DAY_MS),
      to: s.toFacility,
      boxes: s._count.items,
    }));

    // ---- Capacity
    const capacityMT = num(warehouse.capacityMetricTonnes);
    const usedPallets = batches.reduce((sum, b) => sum + b.pallets, 0);
    const incomingPallets = incoming.reduce((sum, s) => sum + Math.ceil(s.boxes / DEFAULT_BOXES_PER_PALLET), 0);
    // Pallet positions: from capacity when known (about a tonne each), else
    // enough room for what is there plus headroom, so the view still makes sense.
    const capacityPallets = capacityMT ? Math.max(1, Math.round(capacityMT)) : null;
    const floorPallets = Math.max(capacityPallets || 0, Math.ceil(usedPallets * 1.3), 24);
    const tonnes = totalWeightKg / 1000;
    const utilisationPct = capacityMT && weightKnown ? round((tonnes / capacityMT) * 100, 1) : null;
    const palletUtilisationPct = capacityPallets ? round((usedPallets / capacityPallets) * 100, 1) : null;

    const insights = buildInsights({
      warehouse,
      batches,
      products,
      incoming,
      outgoing,
      utilisationPct: utilisationPct ?? palletUtilisationPct,
      capacityMT,
      weightKnown,
      boxesCount: boxes.length,
      incomingBoxes: incoming.reduce((sum, s) => sum + s.boxes, 0),
      lastReceive: lastReceive?.createdAt || null,
      lastDispatch: lastDispatch?.createdAt || null,
      now,
    });

    // Write-offs waiting for approval, and the latest stock count.
    const [pendingAdjustments, lastCount] = await Promise.all([
      prisma.stockAdjustment.findMany({
        where: { warehouseId: warehouse.id, status: "PENDING_APPROVAL" },
        select: { id: true, adjustmentNumber: true, reason: true, requestedAt: true, _count: { select: { lines: true } } },
        orderBy: { requestedAt: "asc" },
      }),
      prisma.stockCount.findFirst({
        where: { warehouseId: warehouse.id, status: { not: "CANCELLED" } },
        orderBy: { startedAt: "desc" },
        select: { id: true, countNumber: true, status: true, startedAt: true, submittedAt: true },
      }),
    ]);
    const heldNotPending = boxes.filter((b) => b.heldAt && !b.holdAdjustmentId).length;
    const extra = [];
    if (pendingAdjustments.length) {
      const boxesPending = pendingAdjustments.reduce((sum, a) => sum + a._count.lines, 0);
      extra.push({
        severity: "warning",
        title: `${pendingAdjustments.length} write-off${pendingAdjustments.length === 1 ? "" : "s"} awaiting approval`,
        detail: `${boxesPending} box${boxesPending === 1 ? "" : "es"} on hold until an administrator decides (${pendingAdjustments.map((a) => a.adjustmentNumber).slice(0, 3).join(", ")}).`,
        action: "Country or Super Admin: review in Stock Adjustments",
      });
    }
    if (heldNotPending) {
      extra.push({
        severity: "info",
        title: `${heldNotPending} box${heldNotPending === 1 ? "" : "es"} on hold`,
        detail: "Held stock cannot be dispatched. Release it, or request a write-off if it is unusable.",
        action: null,
      });
    }
    const lastCountAt = lastCount ? lastCount.submittedAt || lastCount.startedAt : null;
    if (boxes.length && (!lastCountAt || now - new Date(lastCountAt) > 90 * DAY_MS)) {
      extra.push({
        severity: "info",
        title: lastCountAt ? "No stock count in the last 90 days" : "No stock count recorded yet",
        detail: lastCountAt ? `Last count ${new Date(lastCountAt).toISOString().slice(0, 10)}.` : "Regular counts catch losses early.",
        action: "Start a stock count",
      });
    }
    if (lastCount?.status === "IN_PROGRESS") {
      extra.push({ severity: "info", title: `Stock count ${lastCount.countNumber} in progress`, detail: "Finish and submit it so differences are recorded.", action: null });
    }
    if (extra.length) {
      insights.push(...extra);
      const rank = { critical: 0, warning: 1, info: 2, good: 3 };
      insights.sort((a, b) => rank[a.severity] - rank[b.severity]);
      if (extra.some((e) => e.severity === "warning")) {
        const goodIdx = insights.findIndex((i) => i.severity === "good");
        if (goodIdx >= 0) insights.splice(goodIdx, 1);
      }
    }

    // Purchase orders still expected at this warehouse.
    const openPos = await prisma.purchaseOrder.findMany({
      where: { destinationWarehouseId: warehouse.id, status: { in: ["OPEN", "PARTIALLY_RECEIVED"] } },
      orderBy: [{ expectedDeliveryDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        poNumber: true,
        supplierName: true,
        expectedDeliveryDate: true,
        status: true,
        currencyCode: true,
        lines: { select: { quantityPacks: true, receivedPacks: true, unitPrice: true, donor: { select: { name: true } }, product: { select: { name: true } } } },
      },
    });
    const expectedPurchaseOrders = openPos.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      supplierName: po.supplierName,
      status: po.status,
      expectedDeliveryDate: po.expectedDeliveryDate,
      overdue: !!po.expectedDeliveryDate && po.expectedDeliveryDate < now,
      outstandingPacks: po.lines.reduce((s, l) => s + Math.max(0, l.quantityPacks - l.receivedPacks), 0),
      outstandingValue: round(po.lines.reduce((s, l) => s + Math.max(0, l.quantityPacks - l.receivedPacks) * Number(l.unitPrice), 0), 2),
      currencyCode: po.currencyCode,
      donors: [...new Set(po.lines.map((l) => l.donor.name))],
      products: [...new Set(po.lines.map((l) => l.product.name))],
    }));
    const overduePos = expectedPurchaseOrders.filter((p) => p.overdue);
    if (overduePos.length) {
      insights.push({
        severity: "warning",
        title: `${overduePos.length} purchase order${overduePos.length === 1 ? "" : "s"} overdue`,
        detail: `Expected delivery date passed: ${overduePos.map((p) => p.poNumber).slice(0, 4).join(", ")}.`,
        action: "Follow up with procurement / the supplier",
      });
      const order = { critical: 0, warning: 1, info: 2, good: 3 };
      insights.sort((a, b) => order[a.severity] - order[b.severity]);
      const goodIdx = insights.findIndex((i) => i.severity === "good");
      if (goodIdx >= 0) insights.splice(goodIdx, 1);
    }

    // Next boxes to pick (FEFO): first 25 boxes in expiry order, skipping expired.
    const pickList = boxes
      .filter((b) => b.expiryDate > now && !b.heldAt)
      .slice(0, 25)
      .map((b) => ({ boxUid: b.boxUid, batchNo: b.batchNo, expiryDate: b.expiryDate, productName: b.product.name, units: b.sachetsRemaining }));

    return res.json({
      warehouse: {
        id: warehouse.id,
        code: warehouse.code,
        name: warehouse.name,
        stockLocationType: warehouse.stockLocationType,
        capacityMetricTonnes: capacityMT,
        county: warehouse.county,
        parent: warehouse.parentStockLocation,
        implementation: warehouse.implementation,
        latitude: num(warehouse.latitude),
        longitude: num(warehouse.longitude),
        // Building for the 3D view. Field bases are usually Rubb halls (tented
        // warehouses) of about 24 x 10 m unless configured otherwise.
        structure: {
          type: warehouse.structureType || (warehouse.stockLocationType === "FIELD_BASE_WAREHOUSE" ? "RUBB_HALL" : "BUILDING"),
          lengthM: num(warehouse.lengthM),
          widthM: num(warehouse.widthM),
          configured: !!warehouse.structureType,
        },
        childWarehouses,
      },
      summary: {
        boxes: boxes.length,
        units: boxes.reduce((s, b) => s + b.sachetsRemaining, 0),
        batches: batches.length,
        products: products.length,
        metricTonnes: weightKnown ? round(tonnes, 3) : null,
        weightKnown,
        utilisationPct,
        usedPallets,
        capacityPallets,
        palletUtilisationPct,
        floorPallets,
        incomingBoxes: incoming.reduce((s, x) => s + x.boxes, 0),
        incomingPallets,
        stockValue: roundMoney(stockValue),
        heldBoxes: boxes.filter((b) => b.heldAt).length,
        pendingWriteOffBoxes: boxes.filter((b) => b.holdAdjustmentId).length,
        pendingWriteOffs: pendingAdjustments.length,
        lastCount: lastCount
          ? { id: lastCount.id, countNumber: lastCount.countNumber, status: lastCount.status, at: lastCount.submittedAt || lastCount.startedAt }
          : null,
        valueComplete: batches.every((b) => b.value !== null),
        expiredBoxes: batches.filter((b) => b.expiryBand === "EXPIRED").reduce((s, b) => s + b.boxes, 0),
        criticalBoxes: batches.filter((b) => b.expiryBand === "CRITICAL").reduce((s, b) => s + b.boxes, 0),
        warningBoxes: batches.filter((b) => b.expiryBand === "WARNING").reduce((s, b) => s + b.boxes, 0),
        lastReceiveAt: lastReceive?.createdAt || null,
        lastDispatchAt: lastDispatch?.createdAt || null,
      },
      layout: { palletMaxKg: PALLET_MAX_KG, defaultBoxesPerPallet: DEFAULT_BOXES_PER_PALLET },
      products,
      donors,
      batches,
      pickList,
      incoming,
      outgoing,
      expectedPurchaseOrders,
      movement: { windowDays: MOVEMENT_WINDOW_DAYS, days },
      insights,
      generatedAt: now,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// Insights: plain-language findings, most urgent first.
// severity: critical | warning | info | good
// ---------------------------------------------------------------------------
function buildInsights(ctx) {
  const out = [];
  const add = (severity, title, detail, action = null) => out.push({ severity, title, detail, action });
  const fmt = (d) => new Date(d).toISOString().slice(0, 10);
  const unitName = (p) => (p?.product?.baseUnitName || "unit").toLowerCase();

  const expired = ctx.batches.filter((b) => b.expiryBand === "EXPIRED");
  if (expired.length) {
    const boxes = expired.reduce((s, b) => s + b.boxes, 0);
    add(
      "critical",
      `${boxes} expired box${boxes === 1 ? "" : "es"} on the shelves`,
      `${expired.length} batch${expired.length === 1 ? "" : "es"} past expiry (${expired.map((b) => b.batchNo).slice(0, 4).join(", ")}). Quarantine them so they are not dispatched.`,
      "Put on hold and request a write-off (Stock Adjustments)"
    );
  }

  const critical = ctx.batches.filter((b) => b.expiryBand === "CRITICAL");
  for (const b of critical.slice(0, 3)) {
    const product = ctx.products.find((p) => p.product.id === b.productId);
    const daily = product?.avgDailyOutUnits || 0;
    const canMove = daily * Math.max(0, b.daysToExpiry);
    const atRisk = Math.max(0, b.units - canMove);
    add(
      "critical",
      `Batch ${b.batchNo} expires in ${b.daysToExpiry} day${b.daysToExpiry === 1 ? "" : "s"}`,
      daily > 0 && atRisk > 0
        ? `${b.boxes} boxes of ${b.productName}. At the current dispatch rate about ${Math.round(atRisk).toLocaleString()} ${unitName(product)}s would still be here on ${fmt(b.expiryDate)}.`
        : `${b.boxes} boxes of ${b.productName}, expiry ${fmt(b.expiryDate)}. Dispatch these first.`,
      daily > 0 && atRisk > 0 ? "Dispatch first, or redistribute to a site with higher demand" : "Dispatch first (FEFO)"
    );
  }

  const util = ctx.utilisationPct;
  if (util !== null && util !== undefined) {
    if (util >= 95) add("critical", `Warehouse is ${util}% full`, "There is almost no room for incoming stock.", "Dispatch to field bases or sites, or pause inbound orders");
    else if (util >= 85) add("warning", `Warehouse is ${util}% full`, "Space is getting tight; plan dispatches before the next delivery.");
    else if (util <= 15 && ctx.boxesCount > 0) add("info", `Only ${util}% of capacity in use`, "Plenty of space available for inbound stock.");
  } else if (!ctx.capacityMT) {
    add("info", "Capacity not set", "Set this warehouse's capacity (metric tonnes) in Supply Configuration to see how full it is.");
  } else if (!ctx.weightKnown) {
    add("info", "Pack weight missing", "Set the gross pack weight for each product in Supply Configuration to calculate how full the warehouse is.");
  }

  if (ctx.incomingBoxes > 0) {
    const late = ctx.incoming.filter((s) => s.daysInTransit > 14);
    add(
      late.length ? "warning" : "info",
      `${ctx.incomingBoxes} box${ctx.incomingBoxes === 1 ? "" : "es"} on the way`,
      `${ctx.incoming.length} shipment${ctx.incoming.length === 1 ? "" : "s"} in transit to this warehouse${late.length ? `; ${late.length} for more than 14 days (${late.map((s) => s.manifestNo).join(", ")})` : ""}.`,
      late.length ? "Follow up the delayed shipments with the sender" : "Prepare space and staff to receive"
    );
  }

  const lateOut = ctx.outgoing.filter((s) => s.daysInTransit > 14);
  if (lateOut.length) {
    add(
      "warning",
      `${lateOut.length} dispatched shipment${lateOut.length === 1 ? "" : "s"} not yet received`,
      `Sent more than 14 days ago: ${lateOut.map((s) => `${s.manifestNo} to ${s.to.name}`).slice(0, 4).join(", ")}.`,
      "Confirm with the receiving site"
    );
  }

  for (const p of ctx.products) {
    if (p.daysOfCover === null) {
      if (p.units > 0 && ctx.lastDispatch === null) continue;
      if (p.units > 0) add("info", `No ${p.product.name} dispatched in ${MOVEMENT_WINDOW_DAYS} days`, `${p.boxes} boxes in stock are not moving.`, "Check demand at the sites this warehouse serves");
      continue;
    }
    if (p.daysOfCover < 30) {
      add("warning", `${p.product.name}: about ${p.daysOfCover} days of stock left`, `At the recent rate of ${p.avgDailyOutUnits.toLocaleString()} ${unitName(p)}s a day.`, "Raise a replenishment order");
    } else if (p.daysOfCover > 365) {
      add("info", `${p.product.name}: over a year of stock`, `About ${p.daysOfCover} days at the recent dispatch rate; check expiry dates against demand.`);
    }
  }

  if (ctx.boxesCount === 0 && ctx.incomingBoxes === 0) {
    add("info", "Warehouse is empty", "No stock in the warehouse and nothing on the way.");
  }

  if (ctx.lastReceive === null && ctx.lastDispatch === null && ctx.boxesCount === 0) {
    // already covered by "empty"
  } else if (ctx.lastDispatch && ctx.now - new Date(ctx.lastDispatch) > 30 * DAY_MS && ctx.boxesCount > 0) {
    add("warning", "No dispatches in the last 30 days", `Last dispatch on ${fmt(ctx.lastDispatch)} while ${ctx.boxesCount} boxes are in stock.`);
  }

  if (!out.some((i) => i.severity === "critical" || i.severity === "warning") && ctx.boxesCount > 0) {
    add("good", "No urgent issues", "Stock is within expiry, capacity and movement thresholds.");
  }

  const order = { critical: 0, warning: 1, info: 2, good: 3 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

module.exports = router;
