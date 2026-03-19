const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

// ---------------- helpers ----------------
function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Scope rules (safe, won’t leak):
 * - SUPER_ADMIN or VIEWER => ALL
 * - WAREHOUSE_OFFICER or assigned to WAREHOUSE => warehouse + its facilities
 * - otherwise => only own facility
 */
async function getScope(req) {
  const role = req.user?.role;
  const facilityId = req.user?.facilityId ? String(req.user.facilityId) : null;
  const facilityType = req.user?.facilityType || null;
  const warehouseId =
    req.user?.warehouseId ? String(req.user.warehouseId) : facilityId;

  if (role === "SUPER_ADMIN" || role === "VIEWER") {
    // ALL facilities
    const facs = await prisma.facility.findMany({
      where: { type: "FACILITY" },
      select: { id: true },
    });
    return {
      mode: "ALL",
      warehouseId: null,
      facilityIdsAll: null, // null means “no restriction”
      facilityIdsFacilitiesOnly: facs.map((f) => f.id),
    };
  }

  // Warehouse scope
  if (role === "WAREHOUSE_OFFICER" || facilityType === "WAREHOUSE") {
    if (!warehouseId) {
      return {
        mode: "NONE",
        warehouseId: null,
        facilityIdsAll: [],
        facilityIdsFacilitiesOnly: [],
      };
    }

    const facilities = await prisma.facility.findMany({
      where: { OR: [{ id: warehouseId }, { warehouseId }] },
      select: { id: true, type: true },
    });

    return {
      mode: "WAREHOUSE",
      warehouseId,
      facilityIdsAll: facilities.map((f) => f.id),
      facilityIdsFacilitiesOnly: facilities
        .filter((f) => f.type === "FACILITY")
        .map((f) => f.id),
    };
  }

  // Facility scope (clinician / facility officer etc.)
  if (!facilityId) {
    return {
      mode: "NONE",
      warehouseId: null,
      facilityIdsAll: [],
      facilityIdsFacilitiesOnly: [],
    };
  }
  return {
    mode: "FACILITY",
    warehouseId: null,
    facilityIdsAll: [facilityId],
    facilityIdsFacilitiesOnly: [facilityId],
  };
}

// -----------------------------------------------------------------------------
// GET /api/dashboard/overview
// Leadership landing page data: warehouse stock, transit, facility stock, expiry, stockout risk, enrollment
// Query params:
//  - days=30 (consumption window)
//  - stockoutThresholdDays=14
//  - expiryWarnDays=60
// -----------------------------------------------------------------------------
router.get("/overview", requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, toInt(req.query.days, 30));
    const stockoutThresholdDays = Math.max(
      1,
      toInt(req.query.stockoutThresholdDays, 14)
    );
    const expiryWarnDays = Math.max(1, toInt(req.query.expiryWarnDays, 60));

    const scope = await getScope(req);
    const today = startOfDay(new Date());
    const warnDate = new Date(today);
    warnDate.setDate(warnDate.getDate() + expiryWarnDays);

    // ---- Warehouse stock (only meaningful for ALL or WAREHOUSE scope) ----
    let boxesInWarehouse = 0;
    if (scope.mode === "ALL") {
      boxesInWarehouse = await prisma.box.count({
        where: { status: "IN_WAREHOUSE" },
      });
    } else if (scope.mode === "WAREHOUSE" && scope.warehouseId) {
      boxesInWarehouse = await prisma.box.count({
        where: { status: "IN_WAREHOUSE", currentFacilityId: scope.warehouseId },
      });
    }

    // ---- Facility stock ----
    const facilityBoxWhere =
      scope.mode === "ALL"
        ? { status: "IN_FACILITY" }
        : {
            status: "IN_FACILITY",
            currentFacilityId: { in: scope.facilityIdsFacilitiesOnly },
          };

    const boxesInFacilities = await prisma.box.count({ where: facilityBoxWhere });
    const sachetsInFacilitiesAgg = await prisma.box.aggregate({
      where: facilityBoxWhere,
      _sum: { sachetsRemaining: true },
    });
    const sachetsInFacilities = sachetsInFacilitiesAgg._sum.sachetsRemaining || 0;

    // Facility store summary (boxes + sachets per facility)
    const facilityAgg = await prisma.box.groupBy({
      by: ["currentFacilityId"],
      where: facilityBoxWhere,
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
    });

    const facilityIds = facilityAgg
      .map((r) => r.currentFacilityId)
      .filter(Boolean);

    const facilities = await prisma.facility.findMany({
      where: { id: { in: facilityIds } },
      select: { id: true, code: true, name: true, type: true },
    });
    const facilityMap = new Map(facilities.map((f) => [f.id, f]));

    const facilityStore = facilityAgg
      .map((r) => {
        const f = facilityMap.get(r.currentFacilityId);
        return {
          facilityId: r.currentFacilityId,
          facilityCode: f?.code || null,
          facilityName: f?.name || null,
          boxCount: r._count._all,
          sachetsRemaining: r._sum.sachetsRemaining || 0,
        };
      })
      .sort((a, b) =>
        (a.facilityName || "").localeCompare(b.facilityName || "")
      );

    // ---- Transit (prefer Shipments) ----
    let boxesInTransit = 0;
    let transitTo = [];

    const shipWhere =
      scope.mode === "ALL"
        ? { status: "DISPATCHED" }
        : scope.mode === "WAREHOUSE"
        ? { status: "DISPATCHED", fromWarehouseId: scope.warehouseId }
        : scope.mode === "FACILITY"
        ? {
            status: "DISPATCHED",
            toFacilityId: scope.facilityIdsFacilitiesOnly[0],
          }
        : { status: "DISPATCHED", id: "__none__" };

    const activeShipments = await prisma.shipment.findMany({
      where: shipWhere,
      orderBy: { dispatchedAt: "desc" },
      take: 100,
      include: {
        toFacility: { select: { id: true, code: true, name: true } },
        fromWarehouse: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true } },
      },
    });

    boxesInTransit = activeShipments.reduce(
      (sum, s) => sum + (s._count.items || 0),
      0
    );

    transitTo = activeShipments.map((s) => ({
      shipmentId: s.id,
      manifestNo: s.manifestNo,
      dispatchedAt: s.dispatchedAt,
      fromWarehouse: s.fromWarehouse,
      toFacility: s.toFacility,
      boxCount: s._count.items || 0,
      waybillUrl: `/api/shipments/${s.id}/waybill.pdf`,
    }));

    // ---- Expiring soon (warehouse + facility stock) ----
    const expWhereBase = {
      expiryDate: { lte: warnDate },
      status: { in: ["IN_WAREHOUSE", "IN_FACILITY"] },
    };

    const expWhere =
      scope.mode === "ALL"
        ? expWhereBase
        : { ...expWhereBase, currentFacilityId: { in: scope.facilityIdsAll } };

    const expiringSoon = await prisma.box.findMany({
      where: expWhere,
      orderBy: { expiryDate: "asc" },
      take: 100,
      select: {
        id: true,
        boxUid: true,
        batchNo: true,
        expiryDate: true,
        status: true,
        sachetsRemaining: true,
        product: { select: { id: true, code: true, name: true } },
        currentFacility: {
          select: { id: true, code: true, name: true, type: true },
        },
      },
    });

    // ---- Children enrolled count ----
    const childWhere =
      scope.mode === "ALL"
        ? {}
        : { facilityId: { in: scope.facilityIdsFacilitiesOnly } };

    const childrenEnrolled = await prisma.child.count({ where: childWhere });

    // ---- Stockout risk (days of stock) ----
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - days);

    const dispenses = await prisma.dispense.findMany({
      where: {
        createdAt: { gte: windowStart },
        boxId: { not: null },
        visit:
          scope.mode === "ALL"
            ? undefined
            : { facilityId: { in: scope.facilityIdsFacilitiesOnly } },
      },
      select: {
        quantitySachets: true,
        visit: { select: { facilityId: true } },
        box: { select: { productId: true } },
      },
      take: 50000,
    });

    // total dispensed per facility+product
    const usageMap = new Map(); // key=facility__product => total
    for (const d of dispenses) {
      const facilityId = d.visit?.facilityId;
      const productId = d.box?.productId;
      if (!facilityId || !productId) continue;
      const key = `${facilityId}__${productId}`;
      usageMap.set(key, (usageMap.get(key) || 0) + (d.quantitySachets || 0));
    }

    // current on-hand per facility+product (sachetsRemaining)
    const stockRows = await prisma.box.findMany({
      where: {
        status: "IN_FACILITY",
        currentFacilityId:
          scope.mode === "ALL"
            ? undefined
            : { in: scope.facilityIdsFacilitiesOnly },
      },
      select: { sachetsRemaining: true, currentFacilityId: true, productId: true },
      take: 50000,
    });

    const stockMap = new Map(); // key=facility__product => onhand
    for (const r of stockRows) {
      const key = `${r.currentFacilityId}__${r.productId}`;
      stockMap.set(key, (stockMap.get(key) || 0) + (r.sachetsRemaining || 0));
    }

    const risk = [];
    for (const [key, totalDispensed] of usageMap.entries()) {
      const avgDaily = totalDispensed / days;
      if (!avgDaily || avgDaily <= 0) continue;
      const onHand = stockMap.get(key) || 0;
      const daysOfStock = onHand / avgDaily;

      if (Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays) {
        const [facilityId, productId] = key.split("__");
        risk.push({ facilityId, productId, onHand, avgDaily, daysOfStock });
      }
    }

    risk.sort((a, b) => a.daysOfStock - b.daysOfStock);
    const topRisk = risk.slice(0, 50);

    const riskFacilityIds = [...new Set(topRisk.map((r) => r.facilityId))];
    const riskProductIds = [...new Set(topRisk.map((r) => r.productId))];

    const [riskFacilities, riskProducts] = await Promise.all([
      prisma.facility.findMany({
        where: { id: { in: riskFacilityIds } },
        select: { id: true, code: true, name: true },
      }),
      prisma.product.findMany({
        where: { id: { in: riskProductIds } },
        select: { id: true, code: true, name: true },
      }),
    ]);

    const rfMap = new Map(riskFacilities.map((f) => [f.id, f]));
    const rpMap = new Map(riskProducts.map((p) => [p.id, p]));

    const stockoutRisk = topRisk.map((r) => ({
      facility: rfMap.get(r.facilityId) || { id: r.facilityId },
      product: rpMap.get(r.productId) || { id: r.productId },
      onHandSachets: r.onHand,
      avgDailyDispense: Number(r.avgDaily.toFixed(2)),
      daysOfStock: Number(r.daysOfStock.toFixed(1)),
    }));

    return res.json({
      kpis: {
        boxesInWarehouse,
        boxesInTransit,
        boxesInFacilities,
        sachetsInFacilities,
        childrenEnrolled,
      },
      transitTo,
      facilityStore,
      expiringSoon,
      stockoutRisk,
      meta: { scope: scope.mode, days, stockoutThresholdDays, expiryWarnDays },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/alerts
// Returns: stockout risk + expiry risk + overdue transit
// Query params:
//  - days=30
//  - stockoutThresholdDays=14
//  - expiryWarnDays=60
//  - transitSlaDays=3
// -----------------------------------------------------------------------------
router.get("/alerts", requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, toInt(req.query.days, 30));
    const stockoutThresholdDays = Math.max(
      1,
      toInt(req.query.stockoutThresholdDays, 14)
    );
    const expiryWarnDays = Math.max(1, toInt(req.query.expiryWarnDays, 60));
    const transitSlaDays = Math.max(1, toInt(req.query.transitSlaDays, 3));

    const scope = await getScope(req);
    const today = startOfDay(new Date());
    const warnDate = new Date(today);
    warnDate.setDate(warnDate.getDate() + expiryWarnDays);

    const alerts = [];

    // ---- Overdue shipments ----
    const slaDate = new Date(today);
    slaDate.setDate(slaDate.getDate() - transitSlaDays);

    const overdueWhere =
      scope.mode === "ALL"
        ? { status: "DISPATCHED", dispatchedAt: { lt: slaDate } }
        : scope.mode === "WAREHOUSE"
        ? {
            status: "DISPATCHED",
            dispatchedAt: { lt: slaDate },
            fromWarehouseId: scope.warehouseId,
          }
        : scope.mode === "FACILITY"
        ? {
            status: "DISPATCHED",
            dispatchedAt: { lt: slaDate },
            toFacilityId: scope.facilityIdsFacilitiesOnly[0],
          }
        : { status: "DISPATCHED", id: "__none__" };

    const overdueShipments = await prisma.shipment.findMany({
      where: overdueWhere,
      orderBy: { dispatchedAt: "asc" },
      take: 50,
      include: {
        toFacility: { select: { id: true, code: true, name: true } },
        fromWarehouse: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true } },
      },
    });

    overdueShipments.forEach((s) => {
      alerts.push({
        type: "OVERDUE_TRANSIT",
        severity: "HIGH",
        shipmentId: s.id,
        manifestNo: s.manifestNo,
        fromWarehouse: s.fromWarehouse,
        toFacility: s.toFacility,
        boxCount: s._count.items || 0,
        dispatchedAt: s.dispatchedAt,
        waybillUrl: `/api/shipments/${s.id}/waybill.pdf`,
      });
    });

    // ---- Expiry risk ----
    const expWhereBase = {
      expiryDate: { lte: warnDate },
      status: { in: ["IN_WAREHOUSE", "IN_FACILITY"] },
    };
    const expWhere =
      scope.mode === "ALL"
        ? expWhereBase
        : { ...expWhereBase, currentFacilityId: { in: scope.facilityIdsAll } };

    const expiring = await prisma.box.findMany({
      where: expWhere,
      orderBy: { expiryDate: "asc" },
      take: 30,
      select: {
        id: true,
        boxUid: true,
        batchNo: true,
        expiryDate: true,
        sachetsRemaining: true,
        product: { select: { code: true, name: true } },
        currentFacility: { select: { code: true, name: true, type: true } },
      },
    });

    expiring.forEach((b) => {
      alerts.push({
        type: "EXPIRY_RISK",
        severity: "MEDIUM",
        boxUid: b.boxUid,
        product: b.product,
        expiryDate: b.expiryDate,
        sachetsRemaining: b.sachetsRemaining,
        location: b.currentFacility,
      });
    });

    // ---- Stockout risk (same logic as overview, but returns as alerts) ----
    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - days);

    const dispenses = await prisma.dispense.findMany({
      where: {
        createdAt: { gte: windowStart },
        boxId: { not: null },
        visit:
          scope.mode === "ALL"
            ? undefined
            : { facilityId: { in: scope.facilityIdsFacilitiesOnly } },
      },
      select: {
        quantitySachets: true,
        visit: { select: { facilityId: true } },
        box: { select: { productId: true } },
      },
      take: 50000,
    });

    const usageMap = new Map();
    for (const d of dispenses) {
      const facilityId = d.visit?.facilityId;
      const productId = d.box?.productId;
      if (!facilityId || !productId) continue;
      const key = `${facilityId}__${productId}`;
      usageMap.set(key, (usageMap.get(key) || 0) + (d.quantitySachets || 0));
    }

    const stockRows = await prisma.box.findMany({
      where: {
        status: "IN_FACILITY",
        currentFacilityId:
          scope.mode === "ALL"
            ? undefined
            : { in: scope.facilityIdsFacilitiesOnly },
      },
      select: { sachetsRemaining: true, currentFacilityId: true, productId: true },
      take: 50000,
    });

    const stockMap = new Map();
    for (const r of stockRows) {
      const key = `${r.currentFacilityId}__${r.productId}`;
      stockMap.set(key, (stockMap.get(key) || 0) + (r.sachetsRemaining || 0));
    }

    const risk = [];
    for (const [key, totalDispensed] of usageMap.entries()) {
      const avgDaily = totalDispensed / days;
      if (!avgDaily || avgDaily <= 0) continue;
      const onHand = stockMap.get(key) || 0;
      const daysOfStock = onHand / avgDaily;
      if (Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays) {
        const [facilityId, productId] = key.split("__");
        risk.push({ facilityId, productId, onHand, avgDaily, daysOfStock });
      }
    }

    risk.sort((a, b) => a.daysOfStock - b.daysOfStock);
    const topRisk = risk.slice(0, 30);

    const facilityIds = [...new Set(topRisk.map((r) => r.facilityId))];
    const productIds = [...new Set(topRisk.map((r) => r.productId))];

    const [facilities, products] = await Promise.all([
      prisma.facility.findMany({
        where: { id: { in: facilityIds } },
        select: { id: true, code: true, name: true },
      }),
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, code: true, name: true },
      }),
    ]);

    const fMap = new Map(facilities.map((f) => [f.id, f]));
    const pMap = new Map(products.map((p) => [p.id, p]));

    topRisk.forEach((r) => {
      alerts.push({
        type: "STOCKOUT_RISK",
        severity: r.daysOfStock <= 7 ? "HIGH" : "MEDIUM",
        facility: fMap.get(r.facilityId) || { id: r.facilityId },
        product: pMap.get(r.productId) || { id: r.productId },
        onHandSachets: r.onHand,
        avgDailyDispense: Number(r.avgDaily.toFixed(2)),
        daysOfStock: Number(r.daysOfStock.toFixed(1)),
      });
    });

    return res.json({
      alerts,
      meta: { scope: scope.mode, days, stockoutThresholdDays, expiryWarnDays, transitSlaDays },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/facilities/:facilityId/store
// Facility Store page data (stock + expiry + consumption + days-of-stock)
//
// Query params:
//  - days=30 (consumption window)
//  - expiryWarnDays=60
//  - stockoutThresholdDays=14
// -----------------------------------------------------------------------------
router.get("/facilities/:facilityId/store", requireAuth, async (req, res) => {
  try {
    const facilityId = String(req.params.facilityId);
    const days = Math.max(1, toInt(req.query.days, 30));
    const expiryWarnDays = Math.max(1, toInt(req.query.expiryWarnDays, 60));
    const stockoutThresholdDays = Math.max(1, toInt(req.query.stockoutThresholdDays, 14));

    const scope = await getScope(req);

    // Enforce scope: user can only query facilities they are allowed to see
    if (scope.mode !== "ALL" && !scope.facilityIdsFacilitiesOnly.includes(facilityId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const facility = await prisma.facility.findUnique({
      where: { id: facilityId },
      select: { id: true, code: true, name: true, type: true, warehouseId: true },
    });

    if (!facility || facility.type !== "FACILITY") {
      return res.status(404).json({ message: "Facility not found" });
    }

    const today = startOfDay(new Date());
    const warnDate = new Date(today);
    warnDate.setDate(warnDate.getDate() + expiryWarnDays);

    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - days);

    // 1) Stock on hand grouped by product
    const stockAgg = await prisma.box.groupBy({
      by: ["productId"],
      where: { status: "IN_FACILITY", currentFacilityId: facilityId },
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
    });

    const productIds = stockAgg.map((r) => r.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, code: true, name: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    // 2) Consumption in last N days (dispenses) grouped by product
    const dispenses = await prisma.dispense.findMany({
      where: {
        createdAt: { gte: windowStart },
        boxId: { not: null },
        visit: { facilityId: facilityId },
      },
      select: {
        quantitySachets: true,
        box: { select: { productId: true } },
      },
      take: 100000,
    });

    const usageMap = new Map(); // productId => total dispensed
    for (const d of dispenses) {
      const productId = d.box?.productId;
      if (!productId) continue;
      usageMap.set(productId, (usageMap.get(productId) || 0) + (d.quantitySachets || 0));
    }

    // 3) Expiring soon in this facility
    const expiringSoon = await prisma.box.findMany({
      where: {
        status: "IN_FACILITY",
        currentFacilityId: facilityId,
        expiryDate: { lte: warnDate },
      },
      orderBy: { expiryDate: "asc" },
      take: 200,
      select: {
        id: true,
        boxUid: true,
        batchNo: true,
        expiryDate: true,
        sachetsRemaining: true,
        product: { select: { id: true, code: true, name: true } },
      },
    });

    // Build byProduct rows
    const byProduct = stockAgg
      .map((r) => {
        const p = productMap.get(r.productId) || { id: r.productId };
        const onHandSachets = r._sum.sachetsRemaining || 0;
        const boxesOnHand = r._count._all || 0;

        const totalDispensed = usageMap.get(r.productId) || 0;
        const avgDailyDispense = totalDispensed / days;

        let daysOfStock = null;
        if (avgDailyDispense > 0) daysOfStock = onHandSachets / avgDailyDispense;

        const isAtRisk =
          daysOfStock !== null && Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays;

        return {
          product: p,
          boxesOnHand,
          onHandSachets,
          avgDailyDispense: Number(avgDailyDispense.toFixed(2)),
          daysOfStock: daysOfStock === null ? null : Number(daysOfStock.toFixed(1)),
          isAtRisk,
        };
      })
      .sort((a, b) => {
        // Sort: risk first, then lowest days of stock
        const ar = a.daysOfStock ?? 999999;
        const br = b.daysOfStock ?? 999999;
        return ar - br;
      });

    const boxesOnHand = byProduct.reduce((s, r) => s + (r.boxesOnHand || 0), 0);
    const sachetsRemaining = byProduct.reduce((s, r) => s + (r.onHandSachets || 0), 0);

    const stockoutRisk = byProduct.filter((r) => r.isAtRisk);

    return res.json({
      facility,
      kpis: { boxesOnHand, sachetsRemaining },
      byProduct,
      stockoutRisk,
      expiringSoon,
      meta: { days, expiryWarnDays, stockoutThresholdDays },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/children  (ANONYMIZED: no names)
// Query: take, skip, q, facilityId
// -----------------------------------------------------------------------------
router.get("/children", requireAuth, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, toInt(req.query.take, 50)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const q = req.query.q ? String(req.query.q).trim() : null;
    const facilityId = req.query.facilityId ? String(req.query.facilityId) : null;

    const scope = await getScope(req);

    const where = {};

    // 1) Apply scope restriction first
    if (scope.mode !== "ALL") {
      where.facilityId = { in: scope.facilityIdsFacilitiesOnly };
    }

    // 2) If facilityId is provided, enforce scope and override
    if (facilityId) {
      if (scope.mode !== "ALL" && !scope.facilityIdsFacilitiesOnly.includes(facilityId)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      where.facilityId = facilityId; // override to single facility
    }

    // 3) Optional search
    if (q) {
      where.OR = [
        { uniqueChildNumber: { contains: q } },
        { cwcNumber: { contains: q } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.child.count({ where }),
      prisma.child.findMany({
        where,
        orderBy: { enrollmentDate: "desc" },
        take,
        skip,
        select: {
          id: true,
          uniqueChildNumber: true,
          sex: true,
          dateOfBirth: true,
          enrollmentDate: true,
          cwcNumber: true,
          facility: { select: { id: true, code: true, name: true } },
        },
      }),
    ]);

    return res.json({ total, take, skip, rows });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/children/:childId/measurements
// Returns visit rows for the child details page. Safely enriches the enrollment
// row with anthropometry captured during the in-depth assessment and exposes
// sachets dispensed per visit.
// -----------------------------------------------------------------------------

router.get("/children/:childId/measurements", requireAuth, async (req, res) => {
  try {
    const childId = String(req.params.childId);
    const scope = await getScope(req);

    const child = await prisma.child.findUnique({
      where: { id: childId },
      select: {
        id: true,
        uniqueChildNumber: true,
        facilityId: true,
        enrollmentDate: true,
      },
    });

    if (!child) return res.status(404).json({ message: "Child not found" });

    if (
      scope.mode !== "ALL" &&
      !scope.facilityIdsFacilitiesOnly.includes(String(child.facilityId))
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const toNumberOrNull = (value) => {
      if (value === null || value === undefined || value === "") return null;
      const n =
        typeof value === "number" ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : null;
    };

    const round2 = (value) => {
      const n = toNumberOrNull(value);
      return n === null ? null : Number(n.toFixed(2));
    };

    const dateKey = (value) => {
      if (!value) return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d.toISOString().slice(0, 10);
    };

    const toDay = (value) => {
      if (!value) return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const firstFinite = (...values) => {
      for (const value of values) {
        const n = toNumberOrNull(value);
        if (n !== null) return n;
      }
      return null;
    };

    const firstValue = (...values) => {
      for (const value of values) {
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return null;
    };

    const pickFromData = (data, keys) => {
      if (!data || typeof data !== "object") return null;

      for (const key of keys) {
        const direct = toNumberOrNull(data?.[key]);
        if (direct !== null) return direct;
      }

      const nestedSources = [
        data.answers,
        data.anthropometry,
        data.measurements,
        data.measurement,
        data.child,
        data.baseline,
      ].filter((value) => value && typeof value === "object");

      for (const source of nestedSources) {
        for (const key of keys) {
          const nested = toNumberOrNull(source?.[key]);
          if (nested !== null) return nested;
        }
      }

      return null;
    };

    const sumDispenses = (dispenses) =>
      (dispenses || []).reduce(
        (sum, item) => sum + (Number(item?.quantitySachets) || 0),
        0
      );

    const [visitsRaw, assessments] = await Promise.all([
      prisma.childVisit.findMany({
        where: { childId: child.id },
        orderBy: { visitDate: "asc" },
        select: {
          id: true,
          visitDate: true,
          weightKg: true,
          heightCm: true,
          muacMm: true,
          whzScore: true,
          nextAppointmentDate: true,
          dispenses: {
            select: {
              id: true,
              quantitySachets: true,
            },
          },
        },
      }),
      prisma.inDepthAssessment.findMany({
        where: { childId: child.id },
        orderBy: { assessmentDate: "asc" },
        select: {
          id: true,
          assessmentType: true,
          assessmentDate: true,
          weightKg: true,
          heightCm: true,
          muacMm: true,
          data: true,
        },
      }),
    ]);

    const today = toDay(new Date());

    const visits = visitsRaw.map((visit, index, arr) => {
      let appointmentStatus = null;

      if (visit.nextAppointmentDate) {
        const dueDate = toDay(visit.nextAppointmentDate);
        const nextVisit = arr.slice(index + 1).find((item) => item.visitDate);
        const nextVisitDate = nextVisit?.visitDate ? toDay(nextVisit.visitDate) : null;

        if (nextVisitDate && dueDate) {
          appointmentStatus = nextVisitDate <= dueDate ? "HONOURED" : "MISSED";
        } else if (dueDate && today && dueDate >= today) {
          appointmentStatus = "UPCOMING";
        } else {
          appointmentStatus = "MISSED";
        }
      }

      return {
        id: visit.id,
        visitDate: visit.visitDate,
        weightKg: visit.weightKg,
        heightCm: visit.heightCm,
        muacMm: visit.muacMm,
        whzScore: round2(visit.whzScore),
        nextAppointmentDate: visit.nextAppointmentDate,
        sachetsDispensed: sumDispenses(visit.dispenses),
        appointmentStatus,
      };
    });

    const enrollmentAssessment =
      assessments.find(
        (assessment) => assessment.assessmentType === "ENROLLMENT"
      ) ||
      assessments[0] ||
      null;

    if (enrollmentAssessment) {
      const enrollmentDateKey =
        dateKey(enrollmentAssessment.assessmentDate) ||
        dateKey(child.enrollmentDate);

      const assessmentWeight = firstFinite(
        enrollmentAssessment.weightKg,
        pickFromData(enrollmentAssessment.data, [
          "weightKg",
          "weight",
          "childWeightKg",
          "baselineWeightKg",
        ])
      );

      const assessmentHeight = firstFinite(
        enrollmentAssessment.heightCm,
        pickFromData(enrollmentAssessment.data, [
          "heightCm",
          "height",
          "lengthCm",
          "childHeightCm",
          "baselineHeightCm",
        ])
      );

      const assessmentMuac = firstFinite(
        enrollmentAssessment.muacMm,
        pickFromData(enrollmentAssessment.data, [
          "muacMm",
          "muac",
          "muacMM",
          "baselineMuacMm",
        ])
      );

      const assessmentWhz = round2(
        firstFinite(
          pickFromData(enrollmentAssessment.data, [
            "whzScore",
            "whz",
            "zScore",
            "weightForHeightZScore",
          ])
        )
      );

      const matchingVisitIndex = visits.findIndex(
        (visit) => dateKey(visit.visitDate) === enrollmentDateKey
      );

      if (matchingVisitIndex >= 0) {
        const existing = visits[matchingVisitIndex];
        visits[matchingVisitIndex] = {
          ...existing,
          weightKg: firstValue(existing.weightKg, assessmentWeight),
          heightCm: firstValue(existing.heightCm, assessmentHeight),
          muacMm: firstValue(existing.muacMm, assessmentMuac),
          whzScore: firstValue(existing.whzScore, assessmentWhz),
        };
      } else {
        visits.unshift({
          id: `assessment-${enrollmentAssessment.id}`,
          visitDate: enrollmentAssessment.assessmentDate || child.enrollmentDate,
          weightKg: assessmentWeight,
          heightCm: assessmentHeight,
          muacMm: assessmentMuac,
          whzScore: assessmentWhz,
          nextAppointmentDate: null,
          sachetsDispensed: 0,
          appointmentStatus: null,
        });
      }
    }

    const latestScheduledVisit =
      [...visits]
        .filter((visit) => visit.nextAppointmentDate)
        .sort((a, b) => {
          const aDate = new Date(a.visitDate || a.nextAppointmentDate);
          const bDate = new Date(b.visitDate || b.nextAppointmentDate);
          return bDate - aDate;
        })[0] || null;

    let appointmentStatus = {
      status: "NO_APPOINTMENT",
      nextAppointmentDate: null,
      daysOverdue: 0,
    };

    if (latestScheduledVisit?.nextAppointmentDate) {
      const dueDate = toDay(latestScheduledVisit.nextAppointmentDate);
      let daysOverdue = 0;

      if (dueDate && today && dueDate < today) {
        daysOverdue = Math.floor(
          (today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24)
        );
      }

      appointmentStatus = {
        status: latestScheduledVisit.appointmentStatus || "UPCOMING",
        nextAppointmentDate: latestScheduledVisit.nextAppointmentDate,
        daysOverdue,
      };
    }

    return res.json({ child, visits, assessments, appointmentStatus });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});
// -----------------------------------------------------------------------------
// GET /api/dashboard/reports/missed-appointments
// Query: fromDate=YYYY-MM-DD, toDate=YYYY-MM-DD, take, skip
// Counts missed appointments and returns the missed appointment rows.
// -----------------------------------------------------------------------------
router.get("/reports/missed-appointments", requireAuth, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, toInt(req.query.take, 10)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const fromDateRaw = req.query.fromDate ? String(req.query.fromDate) : null;
    const toDateRaw = req.query.toDate ? String(req.query.toDate) : null;

    const scope = await getScope(req);

    const parseDateStart = (value) => {
      if (!value) return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(0, 0, 0, 0);
      return d;
    };

    const parseDateEnd = (value) => {
      if (!value) return null;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(23, 59, 59, 999);
      return d;
    };

    const fromDate = parseDateStart(fromDateRaw);
    const toDate = parseDateEnd(toDateRaw);

    const where = {
      nextAppointmentDate: {
        not: null,
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      },
      facilityId:
        scope.mode === "ALL"
          ? undefined
          : { in: scope.facilityIdsFacilitiesOnly },
    };

    const appointmentRows = await prisma.childVisit.findMany({
      where,
      orderBy: [{ nextAppointmentDate: "desc" }, { visitDate: "asc" }],
      select: {
        id: true,
        childId: true,
        facilityId: true,
        visitDate: true,
        nextAppointmentDate: true,
        child: {
          select: {
            id: true,
            uniqueChildNumber: true,
            facility: {
              select: { id: true, code: true, name: true },
            },
          },
        },
      },
    });

    if (!appointmentRows.length) {
      return res.json({
        summary: { missedAppointments: 0 },
        total: 0,
        take,
        skip,
        rows: [],
        filters: {
          fromDate: fromDateRaw,
          toDate: toDateRaw,
        },
      });
    }

    const childIds = [...new Set(appointmentRows.map((r) => r.childId))];

    const allVisits = await prisma.childVisit.findMany({
      where: { childId: { in: childIds } },
      orderBy: [{ childId: "asc" }, { visitDate: "asc" }],
      select: {
        id: true,
        childId: true,
        visitDate: true,
      },
    });

    const visitsByChild = new Map();
    for (const visit of allVisits) {
      if (!visitsByChild.has(visit.childId)) {
        visitsByChild.set(visit.childId, []);
      }
      visitsByChild.get(visit.childId).push(visit);
    }

    const today = startOfDay(new Date());
    const msPerDay = 1000 * 60 * 60 * 24;

    const missedRows = [];

    for (const row of appointmentRows) {
      const dueDate = row.nextAppointmentDate
        ? startOfDay(row.nextAppointmentDate)
        : null;

      if (!dueDate) continue;

      const childVisits = visitsByChild.get(row.childId) || [];
      const currentVisitTime = row.visitDate ? new Date(row.visitDate).getTime() : null;

      const nextVisit = childVisits.find((visit) => {
        if (!visit.visitDate) return false;
        const visitTime = new Date(visit.visitDate).getTime();

        if (currentVisitTime === null) {
          return visit.id !== row.id;
        }

        return visitTime > currentVisitTime;
      });

      const nextVisitDate = nextVisit?.visitDate ? startOfDay(nextVisit.visitDate) : null;

      let status = "UPCOMING";

      if (nextVisitDate) {
        status = nextVisitDate <= dueDate ? "HONOURED" : "MISSED";
      } else if (dueDate < today) {
        status = "MISSED";
      }

      if (status === "MISSED") {
        const lateUntil = nextVisitDate || today;
        const daysLate = Math.max(
          0,
          Math.floor((lateUntil.getTime() - dueDate.getTime()) / msPerDay)
        );

        missedRows.push({
          appointmentId: row.id,
          childId: row.childId,
          uniqueChildNumber: row.child?.uniqueChildNumber || null,
          facility: row.child?.facility || null,
          appointmentDate: row.nextAppointmentDate,
          nextVisitDate: nextVisit?.visitDate || null,
          daysLate,
          status: "MISSED",
        });
      }
    }

    missedRows.sort(
      (a, b) => new Date(b.appointmentDate).getTime() - new Date(a.appointmentDate).getTime()
    );

    const total = missedRows.length;
    const rows = missedRows.slice(skip, skip + take);

    return res.json({
      summary: { missedAppointments: total },
      total,
      take,
      skip,
      rows,
      filters: {
        fromDate: fromDateRaw,
        toDate: toDateRaw,
      },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});
module.exports = router; 