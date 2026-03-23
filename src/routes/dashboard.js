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
function getActiveDayKey(d) {
  return startOfDay(d).getTime();
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
    const requestedFacilityId = req.query.facilityId
      ? String(req.query.facilityId)
      : null;

    const scope = await getScope(req);
    const today = startOfDay(new Date());
    const warnDate = new Date(today);
    warnDate.setDate(warnDate.getDate() + expiryWarnDays);

    let selectedFacilityId = null;
    if (requestedFacilityId) {
      if (
        scope.mode !== "ALL" &&
        !scope.facilityIdsFacilitiesOnly.includes(requestedFacilityId)
      ) {
        return res.status(403).json({ message: "Forbidden" });
      }
      selectedFacilityId = requestedFacilityId;
    }

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

    const facilityBoxWhere = {
      status: "IN_FACILITY",
      currentFacilityId: selectedFacilityId
        ? selectedFacilityId
        : scope.mode === "ALL"
        ? undefined
        : { in: scope.facilityIdsFacilitiesOnly },
    };

    const boxesInFacilities = await prisma.box.count({ where: facilityBoxWhere });
    const sachetsInFacilitiesAgg = await prisma.box.aggregate({
      where: facilityBoxWhere,
      _sum: { sachetsRemaining: true },
    });
    const sachetsInFacilities = sachetsInFacilitiesAgg._sum.sachetsRemaining || 0;
    const sachetsInWarehouse = boxesInWarehouse * 600;

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

    let boxesInTransit = 0;
    let transitTo = [];

    const shipWhere = selectedFacilityId
      ? { status: "DISPATCHED", toFacilityId: selectedFacilityId }
      : scope.mode === "ALL"
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

    const expWhereBase = {
      expiryDate: { lte: warnDate },
      status: { in: ["IN_WAREHOUSE", "IN_FACILITY"] },
    };

    const expWhere = selectedFacilityId
      ? { ...expWhereBase, currentFacilityId: selectedFacilityId }
      : scope.mode === "ALL"
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

    const childWhere = selectedFacilityId
      ? { facilityId: selectedFacilityId }
      : scope.mode === "ALL"
      ? {}
      : { facilityId: { in: scope.facilityIdsFacilitiesOnly } };

    const childrenEnrolled = await prisma.child.count({ where: childWhere });

    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - days);

    const dispenses = await prisma.dispense.findMany({
      where: {
        boxId: { not: null },
        visit: selectedFacilityId
          ? { facilityId: selectedFacilityId, visitDate: { gte: windowStart } }
          : scope.mode === "ALL"
          ? { visitDate: { gte: windowStart } }
          : {
              facilityId: { in: scope.facilityIdsFacilitiesOnly },
              visitDate: { gte: windowStart },
            },
      },
      select: {
        quantitySachets: true,
        visit: { select: { facilityId: true, visitDate: true } },
        box: { select: { productId: true } },
      },
      take: 50000,
    });

    const sachetsDispensed = dispenses.reduce(
      (sum, d) => sum + (Number(d.quantitySachets) || 0),
      0
    );

    const usageMap = new Map();
    const activeDaysMap = new Map();

    for (const d of dispenses) {
      const facilityId = d.visit?.facilityId;
      const productId = d.box?.productId;
      const visitDate = d.visit?.visitDate;
      if (!facilityId || !productId || !visitDate) continue;

      const key = `${facilityId}__${productId}`;
      usageMap.set(
        key,
        (usageMap.get(key) || 0) + (Number(d.quantitySachets) || 0)
      );

      if (!activeDaysMap.has(key)) activeDaysMap.set(key, new Set());
      activeDaysMap.get(key).add(getActiveDayKey(visitDate));
    }

    const stockRows = await prisma.box.findMany({
      where: {
        status: "IN_FACILITY",
        currentFacilityId: selectedFacilityId
          ? selectedFacilityId
          : scope.mode === "ALL"
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
      const activeDispensingDays = activeDaysMap.get(key)?.size || 0;
      const avgDaily =
        activeDispensingDays > 0 ? totalDispensed / activeDispensingDays : 0;

      if (!avgDaily || avgDaily <= 0) continue;

      const onHand = stockMap.get(key) || 0;
      const daysOfStock = onHand / avgDaily;

      if (Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays) {
        const [facilityId, productId] = key.split("__");
        risk.push({
          facilityId,
          productId,
          onHand,
          avgDaily,
          daysOfStock,
          activeDispensingDays,
        });
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
      activeDispensingDays: r.activeDispensingDays,
      avgDailyDispense: Number(r.avgDaily.toFixed(2)),
      daysOfStock: Number(r.daysOfStock.toFixed(1)),
    }));

    return res.json({
      kpis: {
        boxesInWarehouse,
        boxesInTransit,
        boxesInFacilities,
        sachetsInFacilities,
        sachetsInWarehouse,
        sachetsDispensed,
        childrenEnrolled,
      },
      transitTo,
      facilityStore,
      expiringSoon,
      stockoutRisk,
      meta: {
        scope: scope.mode,
        days,
        stockoutThresholdDays,
        expiryWarnDays,
        selectedFacilityId,
      },
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
        boxId: { not: null },
        visit:
          scope.mode === "ALL"
            ? { visitDate: { gte: windowStart } }
            : {
                facilityId: { in: scope.facilityIdsFacilitiesOnly },
                visitDate: { gte: windowStart },
              },
      },
      select: {
        quantitySachets: true,
        visit: { select: { facilityId: true, visitDate: true } },
        box: { select: { productId: true } },
      },
      take: 50000,
    });

    const usageMap = new Map();
    const activeDaysMap = new Map();

    for (const d of dispenses) {
      const facilityId = d.visit?.facilityId;
      const productId = d.box?.productId;
      const visitDate = d.visit?.visitDate;
      if (!facilityId || !productId || !visitDate) continue;

      const key = `${facilityId}__${productId}`;
      usageMap.set(
        key,
        (usageMap.get(key) || 0) + (Number(d.quantitySachets) || 0)
      );

      if (!activeDaysMap.has(key)) activeDaysMap.set(key, new Set());
      activeDaysMap.get(key).add(getActiveDayKey(visitDate));
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
      const activeDispensingDays = activeDaysMap.get(key)?.size || 0;
      const avgDaily =
        activeDispensingDays > 0 ? totalDispensed / activeDispensingDays : 0;

      if (!avgDaily || avgDaily <= 0) continue;

      const onHand = stockMap.get(key) || 0;
      const daysOfStock = onHand / avgDaily;
      if (Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays) {
        const [facilityId, productId] = key.split("__");
        risk.push({
          facilityId,
          productId,
          onHand,
          avgDaily,
          daysOfStock,
          activeDispensingDays,
        });
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
        activeDispensingDays: r.activeDispensingDays,
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
        boxId: { not: null },
        visit: { facilityId: facilityId, visitDate: { gte: windowStart } },
      },
      select: {
        quantitySachets: true,
        box: { select: { productId: true } },
        visit: { select: { visitDate: true } },
      },
      take: 100000,
    });

    const usageMap = new Map();
    const activeDaysMap = new Map();

    for (const d of dispenses) {
      const productId = d.box?.productId;
      const visitDate = d.visit?.visitDate;
      if (!productId || !visitDate) continue;

      usageMap.set(
        productId,
        (usageMap.get(productId) || 0) + (Number(d.quantitySachets) || 0)
      );

      if (!activeDaysMap.has(productId)) activeDaysMap.set(productId, new Set());
      activeDaysMap.get(productId).add(getActiveDayKey(visitDate));
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
        const activeDispensingDays = activeDaysMap.get(r.productId)?.size || 0;
        const avgDailyDispense =
          activeDispensingDays > 0 ? totalDispensed / activeDispensingDays : 0;

        let daysOfStock = null;
        if (avgDailyDispense > 0) daysOfStock = onHandSachets / avgDailyDispense;

        const isAtRisk =
          daysOfStock !== null && Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays;

        return {
          product: p,
          boxesOnHand,
          onHandSachets,
          activeDispensingDays,
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
        enrollmentDate: true,
        facilityId: true,
      },
    });

    if (!child) {
      return res.status(404).json({ message: "Child not found" });
    }

    if (
      scope.mode !== "ALL" &&
      !scope.facilityIdsFacilitiesOnly.includes(child.facilityId)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const [visitsRaw, inDepthAssessments] = await Promise.all([
      prisma.childVisit.findMany({
        where: { childId },
        orderBy: { visitDate: "asc" },
        select: {
          id: true,
          visitDate: true,
          notes: true,
          weightKg: true,
          heightCm: true,
          muacMm: true,
          whzScore: true,
          nextAppointmentDate: true,
          dispenses: {
            select: { quantitySachets: true },
          },
        },
      }),
      prisma.inDepthAssessment.findMany({
        where: { childId },
        orderBy: { assessmentDate: "asc" },
        select: {
          id: true,
          assessmentDate: true,
          assessmentType: true,
          data: true,
          weightKg: true,
          heightCm: true,
          muacMm: true,
        },
      }),
    ]);

    const toNumberOrNull = (value) => {
      if (value === null || value === undefined || value === "") return null;
      if (typeof value === "number") return Number.isFinite(value) ? value : null;

      const cleaned = String(value)
        .trim()
        .replace(/,/g, "")
        .replace(/[^\d.-]/g, "");
      if (!cleaned) return null;

      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    };

    const sameDay = (a, b) => {
      if (!a || !b) return false;
      const da = new Date(a);
      const db = new Date(b);
      return (
        da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate()
      );
    };

    const dayDiffAbs = (a, b) => {
      if (!a || !b) return Number.MAX_SAFE_INTEGER;
      const da = startOfDay(a).getTime();
      const db = startOfDay(b).getTime();
      return Math.abs(Math.round((da - db) / (1000 * 60 * 60 * 24)));
    };

    const normalizeKey = (value) =>
      String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    const collectLeafValues = (obj, path = "", out = []) => {
      if (obj === null || obj === undefined) return out;

      if (Array.isArray(obj)) {
        obj.forEach((item, index) =>
          collectLeafValues(item, `${path}[${index}]`, out)
        );
        return out;
      }

      if (typeof obj === "object") {
        Object.entries(obj).forEach(([key, value]) => {
          const nextPath = path ? `${path}.${key}` : key;
          collectLeafValues(value, nextPath, out);
        });
        return out;
      }

      out.push({ path, value: obj });
      return out;
    };

    const findNumericByHints = (obj, hints = []) => {
      const leaves = collectLeafValues(obj);
      const normalizedHints = hints.map(normalizeKey);

      for (const leaf of leaves) {
        const key = normalizeKey(leaf.path);
        if (!key) continue;

        const matched = normalizedHints.some((hint) => key.includes(hint));
        if (!matched) continue;

        const n = toNumberOrNull(leaf.value);
        if (n !== null) return n;
      }

      return null;
    };

    const extractAssessmentMetrics = (assessment) => {
      const data = assessment?.data || {};

      const weightRaw =
        assessment?.weightKg ??
        findNumericByHints(data, [
          "weightkg",
          "weight",
          "childweight",
          "currentweight",
          "enrollmentweight",
          "baselineweight",
          "bodyweight",
          "wt",
        ]);

      const heightRaw =
        assessment?.heightCm ??
        findNumericByHints(data, [
          "heightcm",
          "height",
          "childheight",
          "currentheight",
          "baselineheight",
          "lengthcm",
          "length",
          "childlength",
        ]);

      const muacRaw =
        assessment?.muacMm ??
        findNumericByHints(data, [
          "muacmm",
          "muaccm",
          "muac",
          "middleupperarmcircumference",
          "midupperarmcircumference",
          "upperarmcircumference",
          "armcircumference",
        ]);

      const whzRaw = findNumericByHints(data, [
        "whzscore",
        "whz",
        "weightforheightzscore",
        "weightforheightz",
        "zwfh",
        "wfhz",
        "zscore",
      ]);

      let muacMm = null;
      if (Number.isFinite(muacRaw)) {
        muacMm =
          muacRaw > 0 && muacRaw < 50
            ? Math.round(muacRaw * 10)
            : Math.round(muacRaw);
      }

      return {
        weightKg: Number.isFinite(weightRaw) ? weightRaw : null,
        heightCm: Number.isFinite(heightRaw) ? heightRaw : null,
        muacMm,
        whzScore: Number.isFinite(whzRaw) ? whzRaw : null,
      };
    };

    const normalizedAssessments = (inDepthAssessments || [])
      .map((assessment) => ({
        id: assessment.id,
        assessmentDate: assessment.assessmentDate,
        assessmentType: assessment.assessmentType,
        ...extractAssessmentMetrics(assessment),
      }))
      .filter((a) =>
        [a.weightKg, a.heightCm, a.muacMm, a.whzScore].some(
          (v) => v !== null && v !== undefined && v !== ""
        )
      );

    let visits = visitsRaw.map((visit) => ({
      id: visit.id,
      visitDate: visit.visitDate,
      notes: visit.notes,
      weightKg: visit.weightKg,
      heightCm: visit.heightCm,
      muacMm: visit.muacMm,
      whzScore: visit.whzScore,
      nextAppointmentDate: visit.nextAppointmentDate,
      sachetsDispensed: (visit.dispenses || []).reduce(
        (sum, d) => sum + (Number(d.quantitySachets) || 0),
        0
      ),
    }));

    const hasAnthro = (visit) =>
      [visit.weightKg, visit.heightCm, visit.muacMm, visit.whzScore].some(
        (v) => v !== null && v !== undefined && v !== ""
      );

    const nearestAssessmentForVisit = (visitDate) => {
      if (!visitDate || !normalizedAssessments.length) return null;

      const sameDayMatch = normalizedAssessments.find((a) =>
        sameDay(a.assessmentDate, visitDate)
      );
      if (sameDayMatch) return sameDayMatch;

      const nearMatches = normalizedAssessments
        .map((a) => ({
          ...a,
          diff: dayDiffAbs(a.assessmentDate, visitDate),
        }))
        .filter((a) => a.diff <= 7)
        .sort((a, b) => a.diff - b.diff);

      return nearMatches[0] || null;
    };

    visits = visits.map((visit, index) => {
      if (hasAnthro(visit)) return visit;

      let matched = nearestAssessmentForVisit(visit.visitDate);

      if (!matched && index === 0 && normalizedAssessments.length > 0) {
        matched = normalizedAssessments[0];
      }

      if (!matched) return visit;

      return {
        ...visit,
        weightKg: visit.weightKg ?? matched.weightKg,
        heightCm: visit.heightCm ?? matched.heightCm,
        muacMm: visit.muacMm ?? matched.muacMm,
        whzScore: visit.whzScore ?? matched.whzScore,
      };
    });

    if (visits.length === 0 && normalizedAssessments.length > 0) {
      const first = normalizedAssessments[0];
      visits = [
        {
          id: `enrollment-${child.id}`,
          visitDate: first.assessmentDate,
          notes: "Enrollment assessment",
          weightKg: first.weightKg,
          heightCm: first.heightCm,
          muacMm: first.muacMm,
          whzScore: first.whzScore,
          nextAppointmentDate: null,
          sachetsDispensed: 0,
        },
      ];
    }

    const today = startOfDay(new Date());

    const computeAppointmentStatus = (currentVisit, nextVisit) => {
      if (!currentVisit?.nextAppointmentDate) return null;

      const dueDate = startOfDay(currentVisit.nextAppointmentDate);
      const nextVisitDate = nextVisit?.visitDate
        ? startOfDay(nextVisit.visitDate)
        : null;

      let status = "UPCOMING";
      if (nextVisitDate) {
        status = nextVisitDate <= dueDate ? "HONOURED" : "MISSED";
      } else if (dueDate < today) {
        status = "MISSED";
      }

      const lateUntil = nextVisitDate || today;
      const daysOverdue =
        status === "MISSED"
          ? Math.max(
              0,
              Math.floor(
                (lateUntil.getTime() - dueDate.getTime()) /
                  (1000 * 60 * 60 * 24)
              )
            )
          : 0;

      return {
        status,
        nextAppointmentDate: currentVisit.nextAppointmentDate,
        nextVisitDate: nextVisit?.visitDate || null,
        daysOverdue,
      };
    };

    visits = visits.map((visit, index) => {
      const appt = computeAppointmentStatus(visit, visits[index + 1]);
      return {
        ...visit,
        appointmentStatus: appt?.status || null,
      };
    });

    let appointmentStatus = null;
    for (let i = visits.length - 1; i >= 0; i -= 1) {
      const appt = computeAppointmentStatus(visits[i], visits[i + 1]);
      if (appt) {
        appointmentStatus = appt;
        break;
      }
    }

    return res.json({
      child: {
        id: child.id,
        uniqueChildNumber: child.uniqueChildNumber,
        enrollmentDate: child.enrollmentDate,
      },
      appointmentStatus,
      visits,
    });
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
router.get("/reports/missed-appointments", requireAuth, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, toInt(req.query.take, 10)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const fromDateRaw = req.query.fromDate ? String(req.query.fromDate) : null;
    const toDateRaw = req.query.toDate ? String(req.query.toDate) : null;
    const requestedFacilityId = req.query.facilityId
      ? String(req.query.facilityId)
      : null;

    const scope = await getScope(req);

    let selectedFacilityId = null;
    if (requestedFacilityId) {
      if (
        scope.mode !== "ALL" &&
        !scope.facilityIdsFacilitiesOnly.includes(requestedFacilityId)
      ) {
        return res.status(403).json({ message: "Forbidden" });
      }
      selectedFacilityId = requestedFacilityId;
    }

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
      facilityId: selectedFacilityId
        ? selectedFacilityId
        : scope.mode === "ALL"
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
          facilityId: selectedFacilityId,
        },
      });
    }

    const childIds = [...new Set(appointmentRows.map((r) => r.childId))];
    const facilityIds = [
      ...new Set(appointmentRows.map((r) => r.facilityId).filter(Boolean)),
    ];

    const [allVisits, reportFacilities] = await Promise.all([
      prisma.childVisit.findMany({
        where: { childId: { in: childIds } },
        orderBy: [{ childId: "asc" }, { visitDate: "asc" }],
        select: {
          id: true,
          childId: true,
          visitDate: true,
        },
      }),
      prisma.facility.findMany({
        where: { id: { in: facilityIds } },
        select: {
          id: true,
          code: true,
          name: true,
        },
      }),
    ]);

    const visitsByChild = new Map();
    for (const visit of allVisits) {
      if (!visitsByChild.has(visit.childId)) {
        visitsByChild.set(visit.childId, []);
      }
      visitsByChild.get(visit.childId).push(visit);
    }

    const facilityMap = new Map(reportFacilities.map((f) => [f.id, f]));

    const today = startOfDay(new Date());
    const msPerDay = 1000 * 60 * 60 * 24;

    const missedRows = [];

    for (const row of appointmentRows) {
      const dueDate = row.nextAppointmentDate
        ? startOfDay(row.nextAppointmentDate)
        : null;

      if (!dueDate) continue;

      const childVisits = visitsByChild.get(row.childId) || [];
      const currentVisitTime = row.visitDate
        ? new Date(row.visitDate).getTime()
        : null;

      const nextVisit = childVisits.find((visit) => {
        if (!visit.visitDate) return false;
        const visitTime = new Date(visit.visitDate).getTime();

        if (currentVisitTime === null) {
          return visit.id !== row.id;
        }

        return visitTime > currentVisitTime;
      });

      const nextVisitDate = nextVisit?.visitDate
        ? startOfDay(nextVisit.visitDate)
        : null;

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
          facility: facilityMap.get(row.facilityId) || null,
          appointmentDate: row.nextAppointmentDate,
          nextVisitDate: nextVisit?.visitDate || null,
          daysLate,
          status: "MISSED",
        });
      }
    }

    missedRows.sort(
      (a, b) =>
        new Date(b.appointmentDate).getTime() -
        new Date(a.appointmentDate).getTime()
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
        facilityId: selectedFacilityId,
      },
    });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", error: String(err.message || err) });
  }
});
// -----------------------------------------------------------------------------
// GET /api/dashboard/reports/honoured-follow-ups
// Query: fromDate=YYYY-MM-DD, toDate=YYYY-MM-DD, take, skip
// Counts honoured follow up visits and returns the honoured rows.
// -----------------------------------------------------------------------------
router.get("/reports/honoured-follow-ups", requireAuth, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, toInt(req.query.take, 10)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const fromDateRaw = req.query.fromDate ? String(req.query.fromDate) : null;
    const toDateRaw = req.query.toDate ? String(req.query.toDate) : null;
    const requestedFacilityId = req.query.facilityId
      ? String(req.query.facilityId)
      : null;

    const scope = await getScope(req);

    let selectedFacilityId = null;
    if (requestedFacilityId) {
      if (
        scope.mode !== "ALL" &&
        !scope.facilityIdsFacilitiesOnly.includes(requestedFacilityId)
      ) {
        return res.status(403).json({ message: "Forbidden" });
      }
      selectedFacilityId = requestedFacilityId;
    }

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
      facilityId: selectedFacilityId
        ? selectedFacilityId
        : scope.mode === "ALL"
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
          },
        },
      },
    });

    if (!appointmentRows.length) {
      return res.json({
        summary: { honouredFollowUps: 0 },
        total: 0,
        take,
        skip,
        rows: [],
        filters: {
          fromDate: fromDateRaw,
          toDate: toDateRaw,
          facilityId: selectedFacilityId,
        },
      });
    }

    const childIds = [...new Set(appointmentRows.map((r) => r.childId))];
    const facilityIds = [
      ...new Set(appointmentRows.map((r) => r.facilityId).filter(Boolean)),
    ];

    const [allVisits, reportFacilities] = await Promise.all([
      prisma.childVisit.findMany({
        where: { childId: { in: childIds } },
        orderBy: [{ childId: "asc" }, { visitDate: "asc" }],
        select: {
          id: true,
          childId: true,
          visitDate: true,
        },
      }),
      prisma.facility.findMany({
        where: { id: { in: facilityIds } },
        select: {
          id: true,
          code: true,
          name: true,
        },
      }),
    ]);

    const visitsByChild = new Map();
    for (const visit of allVisits) {
      if (!visitsByChild.has(visit.childId)) {
        visitsByChild.set(visit.childId, []);
      }
      visitsByChild.get(visit.childId).push(visit);
    }

    const facilityMap = new Map(reportFacilities.map((f) => [f.id, f]));
    const msPerDay = 1000 * 60 * 60 * 24;

    const honouredRows = [];

    for (const row of appointmentRows) {
      const dueDate = row.nextAppointmentDate
        ? startOfDay(row.nextAppointmentDate)
        : null;

      if (!dueDate) continue;

      const childVisits = visitsByChild.get(row.childId) || [];
      const currentVisitTime = row.visitDate
        ? new Date(row.visitDate).getTime()
        : null;

      const nextVisit = childVisits.find((visit) => {
        if (!visit.visitDate) return false;
        const visitTime = new Date(visit.visitDate).getTime();

        if (currentVisitTime === null) {
          return visit.id !== row.id;
        }

        return visitTime > currentVisitTime;
      });

      const nextVisitDate = nextVisit?.visitDate
        ? startOfDay(nextVisit.visitDate)
        : null;

      if (nextVisitDate && nextVisitDate <= dueDate) {
        const daysEarly = Math.max(
          0,
          Math.floor((dueDate.getTime() - nextVisitDate.getTime()) / msPerDay)
        );

        honouredRows.push({
          appointmentId: row.id,
          childId: row.childId,
          uniqueChildNumber: row.child?.uniqueChildNumber || null,
          facility: facilityMap.get(row.facilityId) || null,
          appointmentDate: row.nextAppointmentDate,
          nextVisitDate: nextVisit?.visitDate || null,
          daysEarly,
          status: "HONOURED",
        });
      }
    }

    honouredRows.sort(
      (a, b) =>
        new Date(b.appointmentDate).getTime() -
        new Date(a.appointmentDate).getTime()
    );

    const total = honouredRows.length;
    const rows = honouredRows.slice(skip, skip + take);

    return res.json({
      summary: { honouredFollowUps: total },
      total,
      take,
      skip,
      rows,
      filters: {
        fromDate: fromDateRaw,
        toDate: toDateRaw,
        facilityId: selectedFacilityId,
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
