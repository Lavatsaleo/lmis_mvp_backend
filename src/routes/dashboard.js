const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
// Children, reports and duplicate cases are CLINICAL; stock views are open to all modules.
const { requireModule } = require("../middleware/modules");
const { countryWideImplementationId, locationWithDescendants } = require("../auth/access");

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A facility+product that dispensed within this many days but now has no stock
// is reported as stocked out, even if it has not dispensed in the consumption
// window (it cannot dispense with nothing on hand).
const STOCKOUT_LOOKBACK_DAYS = 90;

// Dispensing is counted per calendar day where the facilities are (a visit
// saved at local midnight must not fall on the previous day in UTC).
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Africa/Nairobi";
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const localDay = (d) => dayFormatter.format(d); // "YYYY-MM-DD"
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Visits reported in DHIS2 (South Sudan) as dispensing rows, like clinical
 * dispenses: sachets the visit reported, on the visit day, for the product the
 * implementation's DHIS2 configuration maps to.
 */
async function dhis2Dispensing({ facilityFilter, since }) {
  const imports = await prisma.dhis2EventImport.findMany({
    where: {
      reportedSachets: { gt: 0 },
      ...(facilityFilter !== undefined ? { facilityId: facilityFilter } : { facilityId: { not: null } }),
      ...(since ? { occurredAt: { gte: since } } : {}),
    },
    select: { implementationId: true, facilityId: true, occurredAt: true, reportedSachets: true, shortfallSachets: true },
    take: 500000,
  });
  if (!imports.length) return [];
  const configs = await prisma.dhis2Config.findMany({
    where: { implementationId: { in: [...new Set(imports.map((i) => i.implementationId))] } },
    select: { implementationId: true, dispenseProductId: true },
  });
  const productFor = new Map(configs.map((c) => [c.implementationId, c.dispenseProductId]));
  return imports
    .filter((i) => i.occurredAt && productFor.get(i.implementationId))
    .map((i) => ({
      facilityId: i.facilityId,
      productId: productFor.get(i.implementationId),
      date: i.occurredAt,
      sachets: i.reportedSachets,
      shortfall: i.shortfallSachets,
      source: "DHIS2",
    }));
}

/**
 * Consumption-based stock position per facility+product.
 *
 * avgDaily = sachets dispensed in the last `days` days / calendar days observed.
 * Dividing by calendar days (not just days with dispensing) matters for clinics
 * that dispense one or two days a week; otherwise their usage is overstated
 * 5-7x. Observation starts at the first dispense if the pair only began
 * dispensing inside the window, so new facilities are not understated either.
 *
 * facilityFilter: undefined (all) | facilityId string | { in: [...] }.
 * Returns one row per pair seen dispensing in the lookback period.
 */
async function computeStockPositions({ facilityFilter, days, today }) {
  const windowStart = new Date(today.getTime() - days * MS_PER_DAY);
  const lookbackDays = Math.max(days, STOCKOUT_LOOKBACK_DAYS);
  const lookbackStart = new Date(today.getTime() - lookbackDays * MS_PER_DAY);
  const tomorrow = new Date(today.getTime() + MS_PER_DAY);

  const visitWhere = { visitDate: { gte: lookbackStart } };
  if (facilityFilter !== undefined) visitWhere.facilityId = facilityFilter;

  const [dispenses, stockAgg, reported] = await Promise.all([
    prisma.dispense.findMany({
      where: { boxId: { not: null }, visit: visitWhere },
      select: {
        quantitySachets: true,
        visit: { select: { facilityId: true, visitDate: true } },
        box: { select: { productId: true } },
      },
      take: 200000,
    }),
    prisma.box.groupBy({
      by: ["currentFacilityId", "productId"],
      where: {
        status: "IN_FACILITY",
        ...(facilityFilter !== undefined ? { currentFacilityId: facilityFilter } : {}),
      },
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
    }),
    dhis2Dispensing({ facilityFilter, since: lookbackStart }),
  ]);

  // Clinical dispenses (Kenya) and DHIS2-reported visits (South Sudan).
  const rows = [
    ...dispenses.map((d) => ({
      facilityId: d.visit?.facilityId,
      productId: d.box?.productId,
      visitDate: d.visit?.visitDate,
      quantitySachets: d.quantitySachets,
    })),
    ...reported.map((r) => ({ facilityId: r.facilityId, productId: r.productId, visitDate: r.date, quantitySachets: r.sachets })),
  ];

  const pairs = new Map();
  for (const d of rows) {
    const facilityId = d.facilityId;
    const productId = d.productId;
    const visitDate = d.visitDate;
    if (!facilityId || !productId || !visitDate) continue;

    const key = `${facilityId}__${productId}`;
    if (!pairs.has(key)) {
      pairs.set(key, { facilityId, productId, windowDispensed: 0, firstDispense: visitDate, activeDays: new Set() });
    }
    const p = pairs.get(key);
    if (visitDate < p.firstDispense) p.firstDispense = visitDate;
    if (visitDate >= windowStart) {
      p.windowDispensed += Number(d.quantitySachets) || 0;
      p.activeDays.add(getActiveDayKey(visitDate));
    }
  }

  const stockMap = new Map(
    stockAgg.map((r) => [
      `${r.currentFacilityId}__${r.productId}`,
      { onHand: r._sum.sachetsRemaining || 0, boxes: r._count._all || 0 },
    ])
  );

  return [...pairs.entries()].map(([key, p]) => {
    const stock = stockMap.get(key) || { onHand: 0, boxes: 0 };
    const observedFrom = p.firstDispense > windowStart ? startOfDay(p.firstDispense) : windowStart;
    const consumptionDays = Math.max(1, Math.min(days, Math.round((tomorrow - observedFrom) / MS_PER_DAY)));
    const avgDaily = p.windowDispensed / consumptionDays;
    const daysOfStock = avgDaily > 0 ? stock.onHand / avgDaily : stock.onHand === 0 ? 0 : null;

    return {
      facilityId: p.facilityId,
      productId: p.productId,
      onHand: stock.onHand,
      boxesOnHand: stock.boxes,
      avgDaily,
      daysOfStock,
      consumptionDays,
      activeDispensingDays: p.activeDays.size,
      stockedOut: stock.onHand === 0,
    };
  });
}

// Pairs at or below the threshold, most urgent first.
function riskRowsFrom(positions, stockoutThresholdDays) {
  return positions
    .filter((r) => r.daysOfStock !== null && Number.isFinite(r.daysOfStock) && r.daysOfStock <= stockoutThresholdDays)
    .sort((a, b) => a.daysOfStock - b.daysOfStock);
}

function stockRiskPayload(r, facility, product) {
  return {
    facility: facility || { id: r.facilityId },
    product: product || { id: r.productId },
    onHandSachets: r.onHand,
    activeDispensingDays: r.activeDispensingDays,
    consumptionDays: r.consumptionDays,
    stockedOut: r.stockedOut,
    avgDailyDispense: Number(r.avgDaily.toFixed(2)),
    daysOfStock: Number(r.daysOfStock.toFixed(1)),
  };
}

// Display name for stock quantities on dashboard pages. Quantities are in each
// product's base unit (sachet, tablet...); when every product in scope uses the
// same one, show its name, otherwise a neutral "Unit".
async function stockUnitFor(req) {
  const where = { isActive: true };
  if (req.user?.role !== "SUPER_ADMIN" && req.user?.implementationId) {
    where.implementationId = req.user.implementationId;
  }
  const rows = await prisma.product.findMany({ where, select: { baseUnitName: true }, distinct: ["baseUnitName"] });
  const names = [...new Set(rows.map((r) => String(r.baseUnitName || "").trim()).filter(Boolean))];
  const singular = names.length === 1 ? names[0] : "Unit";
  return { singular, plural: /s$/i.test(singular) ? singular : `${singular}s` };
}

async function lookupFacilitiesAndProducts(rows) {
  const facilityIds = [...new Set(rows.map((r) => r.facilityId))];
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const [facilities, products] = await Promise.all([
    prisma.facility.findMany({ where: { id: { in: facilityIds } }, select: { id: true, code: true, name: true } }),
    prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, code: true, name: true } }),
  ]);
  return {
    facilityMap: new Map(facilities.map((f) => [f.id, f])),
    productMap: new Map(products.map((p) => [p.id, p])),
  };
}

/**
 * Scope rules (safe, won’t leak):
 * - SUPER_ADMIN => ALL (every warehouse, every implementation)
 * - COUNTRY_ADMIN, or a VIEWER with a country but no location => every
 *   location in that implementation (mode WAREHOUSE over all its warehouses)
 * - Anyone assigned to a WAREHOUSE (WAREHOUSE_OFFICER, or a VIEWER placed on a
 *   warehouse) => that warehouse + every location below it (field bases and
 *   their sites; in Kenya's one-level setup, the warehouse + its facilities)
 * - Anyone assigned to a FACILITY (including a VIEWER) => only that facility
 * - No assignment => nothing
 * In WAREHOUSE mode `warehouseIds` lists every warehouse in scope (stock held
 * there, shipments in and out); `warehouseId` is the assigned one, if any.
 */
async function getScope(req) {
  const role = req.user?.role;
  const facilityId = req.user?.facilityId ? String(req.user.facilityId) : null;
  const facilityType = req.user?.facilityType || null;
  const warehouseId =
    req.user?.warehouseId ? String(req.user.warehouseId) : facilityId;

  const NONE = {
    mode: "NONE",
    warehouseId: null,
    warehouseIds: [],
    facilityIdsAll: [],
    facilityIdsFacilitiesOnly: [],
  };

  const scopeFrom = (locations, assignedWarehouseId) => ({
    mode: "WAREHOUSE",
    warehouseId: assignedWarehouseId,
    warehouseIds: locations.filter((f) => f.type === "WAREHOUSE").map((f) => f.id),
    facilityIdsAll: locations.map((f) => f.id),
    facilityIdsFacilitiesOnly: locations.filter((f) => f.type === "FACILITY").map((f) => f.id),
  });

  if (role === "SUPER_ADMIN") {
    // One country when the page asks for it (?implementationId=), so Kenya and
    // South Sudan figures are not added together; otherwise all countries.
    const requested = req.query?.implementationId ? String(req.query.implementationId) : null;
    if (requested && requested !== "ALL") {
      const locations = await prisma.facility.findMany({
        where: { implementationId: requested },
        select: { id: true, type: true },
      });
      return scopeFrom(locations, null);
    }
    // ALL facilities
    const facs = await prisma.facility.findMany({
      where: { type: "FACILITY" },
      select: { id: true },
    });
    return {
      mode: "ALL",
      warehouseId: null,
      warehouseIds: null,
      facilityIdsAll: null, // null means “no restriction”
      facilityIdsFacilitiesOnly: facs.map((f) => f.id),
    };
  }

  // Whole country
  const countryId = countryWideImplementationId(req.user);
  if (countryId) {
    const locations = await prisma.facility.findMany({
      where: { implementationId: countryId },
      select: { id: true, type: true },
    });
    return scopeFrom(locations, null);
  }

  // Warehouse scope
  if (role === "WAREHOUSE_OFFICER" || facilityType === "WAREHOUSE") {
    if (!warehouseId) return NONE;

    const ids = await locationWithDescendants(warehouseId);
    const locations = await prisma.facility.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true },
    });
    return scopeFrom(locations, warehouseId);
  }

  // Facility scope (clinician / facility officer etc.)
  if (!facilityId) return NONE;
  return {
    mode: "FACILITY",
    warehouseId: null,
    warehouseIds: [],
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
    let sachetsInWarehouse = 0;
    const warehouseBoxWhere =
      scope.mode === "ALL"
        ? { status: "IN_WAREHOUSE" }
        : scope.mode === "WAREHOUSE" && scope.warehouseIds.length
        ? { status: "IN_WAREHOUSE", currentFacilityId: { in: scope.warehouseIds } }
        : null;
    if (warehouseBoxWhere) {
      // Summed from the boxes themselves: pack sizes are configurable, so
      // boxes x 600 is no longer a valid estimate.
      const warehouseAgg = await prisma.box.aggregate({
        where: warehouseBoxWhere,
        _count: { _all: true },
        _sum: { sachetsRemaining: true },
      });
      boxesInWarehouse = warehouseAgg._count._all || 0;
      sachetsInWarehouse = warehouseAgg._sum.sachetsRemaining || 0;
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

    const shipWhere = selectedFacilityId
      ? { status: "DISPATCHED", toFacilityId: selectedFacilityId }
      : scope.mode === "ALL"
      ? { status: "DISPATCHED" }
      : scope.mode === "WAREHOUSE"
      ? // Outgoing, plus transfers coming in (a field base awaiting stock).
        { status: "DISPATCHED", OR: [{ fromWarehouseId: { in: scope.warehouseIds } }, { toFacilityId: { in: scope.warehouseIds } }] }
      : scope.mode === "FACILITY"
      ? {
          status: "DISPATCHED",
          toFacilityId: scope.facilityIdsFacilitiesOnly[0],
        }
      : { status: "DISPATCHED", id: "__none__" };

    // A shipment stays DISPATCHED until its last box is received, so count only
    // items not yet received, and count them across all open shipments (the
    // list below is capped for display, the KPI is not).
    const [boxesInTransit, activeShipments] = await Promise.all([
      prisma.shipmentItem.count({ where: { receivedAt: null, shipment: shipWhere } }),
      prisma.shipment.findMany({
        where: shipWhere,
        orderBy: { dispatchedAt: "desc" },
        take: 100,
        include: {
          toFacility: { select: { id: true, code: true, name: true } },
          fromWarehouse: { select: { id: true, code: true, name: true } },
          _count: { select: { items: { where: { receivedAt: null } } } },
        },
      }),
    ]);

    const transitTo = activeShipments.map((s) => ({
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

    const facilityFilter = selectedFacilityId
      ? selectedFacilityId
      : scope.mode === "ALL"
      ? undefined
      : { in: scope.facilityIdsFacilitiesOnly };

    const [dispensedAgg, positions] = await Promise.all([
      prisma.dispense.aggregate({
        where: {
          boxId: { not: null },
          visit: {
            visitDate: { gte: windowStart },
            ...(facilityFilter !== undefined ? { facilityId: facilityFilter } : {}),
          },
        },
        _sum: { quantitySachets: true },
      }),
      computeStockPositions({ facilityFilter, days, today }),
    ]);
    const sachetsDispensed = dispensedAgg._sum.quantitySachets || 0;

    const topRisk = riskRowsFrom(positions, stockoutThresholdDays).slice(0, 50);
    const { facilityMap: rfMap, productMap: rpMap } = await lookupFacilitiesAndProducts(topRisk);
    const stockoutRisk = topRisk.map((r) => stockRiskPayload(r, rfMap.get(r.facilityId), rpMap.get(r.productId)));
    const unit = await stockUnitFor(req);

    return res.json({
      unit,
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
            OR: [{ fromWarehouseId: { in: scope.warehouseIds } }, { toFacilityId: { in: scope.warehouseIds } }],
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
        // Boxes still outstanding, not boxes already received from this shipment.
        _count: { select: { items: { where: { receivedAt: null } } } },
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
    const positions = await computeStockPositions({
      facilityFilter: scope.mode === "ALL" ? undefined : { in: scope.facilityIdsFacilitiesOnly },
      days,
      today,
    });
    const topRisk = riskRowsFrom(positions, stockoutThresholdDays).slice(0, 30);
    const { facilityMap: fMap, productMap: pMap } = await lookupFacilitiesAndProducts(topRisk);

    topRisk.forEach((r) => {
      alerts.push({
        type: "STOCKOUT_RISK",
        severity: r.daysOfStock <= 7 ? "HIGH" : "MEDIUM",
        ...stockRiskPayload(r, fMap.get(r.facilityId), pMap.get(r.productId)),
      });
    });

    return res.json({
      alerts,
      unit: await stockUnitFor(req),
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
// -----------------------------------------------------------------------------
// GET /api/dashboard/facility-list?implementationId=
// Facilities in the user's scope for the Facility Store picker: where each one
// is (county, supplying warehouse) and what it holds now.
// -----------------------------------------------------------------------------
router.get("/facility-list", requireAuth, async (req, res) => {
  try {
    const scope = await getScope(req);
    const where = { type: "FACILITY" };
    if (scope.mode !== "ALL") where.id = { in: scope.facilityIdsFacilitiesOnly };
    const facilities = await prisma.facility.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        county: { select: { name: true } },
        parentStockLocation: { select: { name: true } },
        warehouse: { select: { name: true } },
        implementation: { select: { country: { select: { name: true } } } },
      },
    });
    const stock = await prisma.box.groupBy({
      by: ["currentFacilityId"],
      where: { status: "IN_FACILITY", currentFacilityId: { in: facilities.map((f) => f.id) } },
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
    });
    const stockBy = new Map(stock.map((r) => [r.currentFacilityId, r]));
    const rows = facilities
      .map((f) => ({
        id: f.id,
        code: f.code,
        name: f.name,
        county: f.county?.name || null,
        suppliedBy: f.parentStockLocation?.name || f.warehouse?.name || null,
        country: f.implementation?.country?.name || null,
        boxesOnHand: stockBy.get(f.id)?._count._all || 0,
        sachetsOnHand: stockBy.get(f.id)?._sum.sachetsRemaining || 0,
      }))
      .sort((a, b) => String(a.suppliedBy || "").localeCompare(String(b.suppliedBy || "")) || a.name.localeCompare(b.name));
    return res.json({ rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

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
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        warehouseId: true,
        county: { select: { name: true } },
        parentStockLocation: { select: { name: true } },
        warehouse: { select: { name: true } },
        implementation: { select: { country: { select: { name: true } } } },
      },
    });

    if (!facility || facility.type !== "FACILITY") {
      return res.status(404).json({ message: "Facility not found" });
    }

    const today = startOfDay(new Date());
    const warnDate = new Date(today);
    warnDate.setDate(warnDate.getDate() + expiryWarnDays);

    // 1) Stock on hand grouped by product
    const stockAgg = await prisma.box.groupBy({
      by: ["productId"],
      where: { status: "IN_FACILITY", currentFacilityId: facilityId },
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
    });

    // 2) Consumption-based position per product (includes products that ran
    //    out recently, which have no boxes on hand).
    const positions = await computeStockPositions({ facilityFilter: facilityId, days, today });
    const positionByProduct = new Map(positions.map((p) => [p.productId, p]));

    const productIds = [...new Set([...stockAgg.map((r) => r.productId), ...positions.map((p) => p.productId)])];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, code: true, name: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const stockByProduct = new Map(stockAgg.map((r) => [r.productId, r]));

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
    const byProduct = productIds
      .map((productId) => {
        const p = productMap.get(productId) || { id: productId };
        const stock = stockByProduct.get(productId);
        const position = positionByProduct.get(productId);
        const onHandSachets = stock?._sum.sachetsRemaining || 0;
        const boxesOnHand = stock?._count._all || 0;

        // No dispensing in the lookback: nothing to project from.
        const avgDailyDispense = position ? position.avgDaily : 0;
        const daysOfStock = position ? position.daysOfStock : null;

        const isAtRisk =
          daysOfStock !== null && Number.isFinite(daysOfStock) && daysOfStock <= stockoutThresholdDays;

        return {
          product: p,
          boxesOnHand,
          onHandSachets,
          activeDispensingDays: position?.activeDispensingDays || 0,
          consumptionDays: position?.consumptionDays || 0,
          stockedOut: onHandSachets === 0,
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

    // ---- Dispensed at this facility: clinical visits in Anchor and/or
    //      visits reported in DHIS2, per local day.
    const [clinical, reported] = await Promise.all([
      prisma.dispense.findMany({
        where: { visit: { facilityId } },
        select: { quantitySachets: true, visit: { select: { visitDate: true } }, box: { select: { productId: true } } },
        take: 500000,
      }),
      dhis2Dispensing({ facilityFilter: facilityId }),
    ]);
    const dispRows = [
      ...clinical.filter((d) => d.visit?.visitDate).map((d) => ({ day: localDay(d.visit.visitDate), sachets: Number(d.quantitySachets) || 0, productId: d.box?.productId || null, shortfall: 0, source: "CLINICAL" })),
      ...reported.map((r) => ({ day: localDay(r.date), sachets: r.sachets, productId: r.productId, shortfall: r.shortfall || 0, source: "DHIS2" })),
    ];
    const todayKey = localDay(new Date());
    const windowFrom = shiftDay(todayKey, -(days - 1));
    const sumWhere = (fn) => dispRows.reduce((n, r) => (fn(r) ? n + r.sachets : n), 0);
    const perDay = new Map();
    for (const r of dispRows) if (r.day >= windowFrom && r.day <= todayKey) perDay.set(r.day, (perDay.get(r.day) || 0) + r.sachets);
    const byDay = [];
    for (let d = windowFrom; d <= todayKey; d = shiftDay(d, 1)) byDay.push({ day: d, sachets: perDay.get(d) || 0 });
    const dispProductIds = [...new Set(dispRows.map((r) => r.productId).filter(Boolean))];
    const dispProducts = dispProductIds.length
      ? await prisma.product.findMany({ where: { id: { in: dispProductIds } }, select: { id: true, code: true, name: true } })
      : [];
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? String(req.query.to) : null;
    const sources = [...new Set(dispRows.map((r) => r.source))];
    const dispDays = dispRows.map((r) => r.day).sort();
    const dispensed = {
      source: sources.length > 1 ? "BOTH" : sources[0] || null,
      timezone: REPORT_TIMEZONE,
      today: sumWhere((r) => r.day === todayKey),
      yesterday: sumWhere((r) => r.day === shiftDay(todayKey, -1)),
      last7Days: sumWhere((r) => r.day >= shiftDay(todayKey, -6) && r.day <= todayKey),
      lastWindow: sumWhere((r) => r.day >= windowFrom && r.day <= todayKey),
      allTime: sumWhere(() => true),
      firstDay: dispDays[0] || null,
      lastDay: dispDays[dispDays.length - 1] || null,
      notInStock: dispRows.reduce((n, r) => n + r.shortfall, 0),
      byDay,
      byProduct: dispProducts.map((p) => ({
        product: p,
        allTime: sumWhere((r) => r.productId === p.id),
        lastWindow: sumWhere((r) => r.productId === p.id && r.day >= windowFrom && r.day <= todayKey),
      })),
      range: from || to ? { from, to, sachets: sumWhere((r) => (!from || r.day >= from) && (!to || r.day <= to)) } : null,
    };

    // ---- What is on the shelf, by batch (earliest expiry first)
    const batchRows = await prisma.box.groupBy({
      by: ["productId", "batchNo", "expiryDate"],
      where: { status: "IN_FACILITY", currentFacilityId: facilityId },
      _count: { _all: true },
      _sum: { sachetsRemaining: true },
      orderBy: { expiryDate: "asc" },
    });
    const batches = batchRows.map((b) => ({
      product: productMap.get(b.productId) || { id: b.productId },
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      boxes: b._count._all,
      sachets: b._sum.sachetsRemaining || 0,
    }));

    // ---- Deliveries: on the way here, and recently received
    const shipmentSelect = {
      id: true,
      manifestNo: true,
      status: true,
      dispatchedAt: true,
      receivedAt: true,
      fromWarehouse: { select: { name: true } },
      _count: { select: { items: true } },
    };
    const [incoming, received] = await Promise.all([
      prisma.shipment.findMany({ where: { toFacilityId: facilityId, status: "DISPATCHED" }, orderBy: { dispatchedAt: "desc" }, take: 10, select: shipmentSelect }),
      prisma.shipment.findMany({ where: { toFacilityId: facilityId, status: "RECEIVED" }, orderBy: { receivedAt: "desc" }, take: 5, select: shipmentSelect }),
    ]);
    const shipmentRow = (x) => ({
      id: x.id,
      manifestNo: x.manifestNo,
      from: x.fromWarehouse?.name || null,
      dispatchedAt: x.dispatchedAt,
      receivedAt: x.receivedAt,
      boxes: x._count.items,
    });

    return res.json({
      facility: {
        id: facility.id,
        code: facility.code,
        name: facility.name,
        type: facility.type,
        county: facility.county?.name || null,
        suppliedBy: facility.parentStockLocation?.name || facility.warehouse?.name || null,
        country: facility.implementation?.country?.name || null,
      },
      unit: await stockUnitFor(req),
      kpis: { boxesOnHand, sachetsRemaining, sachetsDispensed: dispensed.allTime },
      batches,
      nextExpiry: batches[0]?.expiryDate || null,
      deliveries: { incoming: incoming.map(shipmentRow), received: received.map(shipmentRow) },
      dispensed,
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
router.get("/children", requireAuth, requireModule("CLINICAL"), async (req, res) => {
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

router.get("/children/:childId/measurements", requireAuth, requireModule("CLINICAL"), async (req, res) => {
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
router.get("/reports/missed-appointments", requireAuth, requireModule("CLINICAL"), async (req, res) => {
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
// GET /api/dashboard/reports/not-dispensed
// Query: fromDate=YYYY-MM-DD, toDate=YYYY-MM-DD (visit date), facilityId, take, skip
// Visits where nothing could be dispensed (e.g. enrollment during a stock-out).
// Each row says whether the child has since been dispensed at a later visit.
// -----------------------------------------------------------------------------
router.get("/reports/not-dispensed", requireAuth, requireModule("CLINICAL"), async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, toInt(req.query.take, 10)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const fromDateRaw = req.query.fromDate ? String(req.query.fromDate) : null;
    const toDateRaw = req.query.toDate ? String(req.query.toDate) : null;
    const requestedFacilityId = req.query.facilityId ? String(req.query.facilityId) : null;

    const scope = await getScope(req);
    if (requestedFacilityId && scope.mode !== "ALL" && !scope.facilityIdsFacilitiesOnly.includes(requestedFacilityId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const fromDate = fromDateRaw ? startOfDay(fromDateRaw) : null;
    const toDate = toDateRaw ? new Date(startOfDay(toDateRaw).getTime() + MS_PER_DAY - 1) : null;
    if ((fromDate && isNaN(fromDate.getTime())) || (toDate && isNaN(toDate.getTime()))) {
      return res.status(400).json({ message: "fromDate/toDate must be valid dates (YYYY-MM-DD)" });
    }

    const where = {
      notDispensedReason: { not: null },
      ...(fromDate || toDate
        ? { visitDate: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
        : {}),
      facilityId: requestedFacilityId
        ? requestedFacilityId
        : scope.mode === "ALL"
        ? undefined
        : { in: scope.facilityIdsFacilitiesOnly },
    };

    const [total, visits] = await Promise.all([
      prisma.childVisit.count({ where }),
      prisma.childVisit.findMany({
        where,
        orderBy: [{ visitDate: "desc" }, { id: "asc" }],
        take,
        skip,
        select: {
          id: true,
          childId: true,
          visitDate: true,
          sachetsPrescribed: true,
          notDispensedReason: true,
          child: { select: { uniqueChildNumber: true } },
          facility: { select: { id: true, code: true, name: true } },
        },
      }),
    ]);

    // Earliest later visit with a dispense, per row.
    const later = visits.length
      ? await prisma.childVisit.findMany({
          where: {
            childId: { in: [...new Set(visits.map((v) => v.childId))] },
            dispenses: { some: {} },
          },
          select: { childId: true, visitDate: true },
          orderBy: { visitDate: "asc" },
        })
      : [];

    const rows = visits.map((v) => {
      const next = later.find((l) => l.childId === v.childId && l.visitDate > v.visitDate);
      return {
        visitId: v.id,
        childId: v.childId,
        uniqueChildNumber: v.child?.uniqueChildNumber || null,
        facility: v.facility,
        visitDate: v.visitDate,
        sachetsPrescribed: v.sachetsPrescribed,
        reason: v.notDispensedReason,
        dispensedLaterOn: next ? next.visitDate : null,
      };
    });

    return res.json({
      summary: { notDispensed: total },
      total,
      take,
      skip,
      rows,
      filters: { fromDate: fromDateRaw, toDate: toDateRaw, facilityId: requestedFacilityId },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/reports/honoured-follow-ups
// Query: fromDate=YYYY-MM-DD, toDate=YYYY-MM-DD, take, skip
// Counts honoured follow up visits and returns the honoured rows.
// -----------------------------------------------------------------------------
router.get("/reports/honoured-follow-ups", requireAuth, requireModule("CLINICAL"), async (req, res) => {
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


// -----------------------------------------------------------------------------
// Duplicate review queue
// Mobile users continue service delivery. These dashboard endpoints let reviewers
// inspect and resolve possible duplicate children later.
// -----------------------------------------------------------------------------
function canReviewDuplicateCases(req) {
  const role = String(req.user?.role || "").toUpperCase();
  return [
    "SUPER_ADMIN",
    "COUNTRY_ADMIN",
    "VIEWER",
    "WAREHOUSE_OFFICER",
    "FACILITY_OFFICER",
    "CLINICIAN",
  ].includes(role);
}

// VIEWER can see duplicate cases but is read-only, so cannot resolve them.
function canResolveDuplicateCases(req) {
  return canReviewDuplicateCases(req) && String(req.user?.role || "").toUpperCase() !== "VIEWER";
}

function duplicateCaseScopeWhere(scope) {
  if (!scope || scope.mode === "ALL") return {};
  const ids = Array.isArray(scope.facilityIdsFacilitiesOnly)
    ? scope.facilityIdsFacilitiesOnly.filter(Boolean)
    : [];
  if (!ids.length) return { id: "__none__" };
  return {
    OR: [
      { facilityId: { in: ids } },
      { matchingFacilityId: { in: ids } },
    ],
  };
}

function normalizeDuplicateStatusFilter(value) {
  const s = String(value || "").trim().toUpperCase();
  if (!s || s === "ALL") return null;
  return s;
}

function mapDuplicateResolutionActionToStatus(action) {
  const a = String(action || "").trim().toUpperCase();
  if (a === "NOT_DUPLICATE" || a === "RESOLVED_NOT_DUPLICATE") return "RESOLVED_NOT_DUPLICATE";
  if (a === "DUPLICATE" || a === "RESOLVED_DUPLICATE") return "RESOLVED_DUPLICATE";
  if (a === "TRANSFER" || a === "TRANSFER_APPROVED") return "TRANSFER_APPROVED";
  if (a === "MERGE" || a === "MERGED") return "MERGED";
  if (a === "CLOSE" || a === "CLOSED") return "CLOSED";
  if (a === "UNDER_REVIEW" || a === "KEEP_UNDER_REVIEW") return "UNDER_REVIEW";
  return null;
}

function summarizeDuplicateChild(child) {
  if (!child) return null;
  const visits = Array.isArray(child.visits) ? child.visits : [];
  const lastVisit = visits[0] || null;
  const lastSachetsDispensed = lastVisit && Array.isArray(lastVisit.dispenses)
    ? lastVisit.dispenses.reduce((sum, d) => sum + Number(d.quantitySachets || 0), 0)
    : 0;

  return {
    id: child.id,
    uniqueChildNumber: child.uniqueChildNumber,
    cwcNumber: child.cwcNumber,
    firstName: child.firstName,
    lastName: child.lastName,
    childName: `${child.firstName || ""} ${child.lastName || ""}`.trim(),
    sex: child.sex,
    dateOfBirth: child.dateOfBirth,
    enrollmentDate: child.enrollmentDate,
    caregiver: child.caregiver
      ? {
          id: child.caregiver.id,
          fullName: child.caregiver.fullName,
          contacts: child.caregiver.contacts,
          village: child.caregiver.village,
        }
      : null,
    facility: child.facility
      ? {
          id: child.facility.id,
          code: child.facility.code,
          name: child.facility.name,
        }
      : null,
    lastVisit: lastVisit
      ? {
          id: lastVisit.id,
          visitDate: lastVisit.visitDate,
          weightKg: lastVisit.weightKg,
          heightCm: lastVisit.heightCm,
          muacMm: lastVisit.muacMm,
          whzScore: lastVisit.whzScore,
          nextAppointmentDate: lastVisit.nextAppointmentDate,
          sachetsDispensed: lastSachetsDispensed,
        }
      : null,
  };
}

async function enrichDuplicateCases(cases) {
  const childIds = [
    ...new Set(
      cases
        .flatMap((c) => [c.primaryChildId, c.duplicateChildId])
        .filter(Boolean)
    ),
  ];

  const facilityIds = [
    ...new Set(
      cases
        .flatMap((c) => [c.facilityId, c.matchingFacilityId])
        .filter(Boolean)
    ),
  ];

  const [children, facilities, users] = await Promise.all([
    childIds.length
      ? prisma.child.findMany({
          where: { id: { in: childIds } },
          include: {
            caregiver: true,
            facility: true,
            visits: {
              orderBy: { visitDate: "desc" },
              take: 1,
              include: { dispenses: true },
            },
          },
        })
      : [],
    facilityIds.length
      ? prisma.facility.findMany({
          where: { id: { in: facilityIds } },
          select: { id: true, code: true, name: true, type: true },
        })
      : [],
    cases.some((c) => c.createdByUserId || c.resolvedByUserId)
      ? prisma.user.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  cases
                    .flatMap((c) => [c.createdByUserId, c.resolvedByUserId])
                    .filter(Boolean)
                ),
              ],
            },
          },
          select: { id: true, fullName: true, email: true, role: true },
        })
      : [],
  ]);

  const childMap = new Map(children.map((c) => [c.id, c]));
  const facilityMap = new Map(facilities.map((f) => [f.id, f]));
  const userMap = new Map(users.map((u) => [u.id, u]));

  return cases.map((c) => ({
    ...c,
    primaryChild: summarizeDuplicateChild(childMap.get(c.primaryChildId)),
    duplicateChild: summarizeDuplicateChild(childMap.get(c.duplicateChildId)),
    facility: c.facilityId ? facilityMap.get(c.facilityId) || null : null,
    matchingFacility: c.matchingFacilityId ? facilityMap.get(c.matchingFacilityId) || null : null,
    createdBy: c.createdByUserId ? userMap.get(c.createdByUserId) || null : null,
    resolvedBy: c.resolvedByUserId ? userMap.get(c.resolvedByUserId) || null : null,
  }));
}

router.get("/duplicate-cases", requireAuth, requireModule("CLINICAL"), async (req, res) => {
  try {
    if (!canReviewDuplicateCases(req)) return res.status(403).json({ message: "Forbidden" });

    const take = Math.min(200, Math.max(1, toInt(req.query.take, 50)));
    const skip = Math.max(0, toInt(req.query.skip, 0));
    const status = normalizeDuplicateStatusFilter(req.query.status || "OPEN");
    const q = String(req.query.q || "").trim();

    const scope = await getScope(req);
    const filters = [];
    const scopedWhere = duplicateCaseScopeWhere(scope);
    if (Object.keys(scopedWhere).length) filters.push(scopedWhere);
    if (status) filters.push({ status });

    if (q) {
      // People search by the child numbers they can see, not internal ids.
      const matchingChildren = await prisma.child.findMany({
        where: { OR: [{ uniqueChildNumber: { contains: q } }, { cwcNumber: { contains: q } }] },
        select: { id: true },
        take: 500,
      });
      const childIds = matchingChildren.map((c) => c.id);

      filters.push({
        OR: [
          { primaryChildId: { contains: q } },
          { duplicateChildId: { contains: q } },
          { mobileDecision: { contains: q } },
          { source: { contains: q } },
          ...(childIds.length
            ? [{ primaryChildId: { in: childIds } }, { duplicateChildId: { in: childIds } }]
            : []),
        ],
      });
    }

    const where = filters.length ? { AND: filters } : {};

    const [total, cases] = await Promise.all([
      prisma.duplicateCase.count({ where }),
      prisma.duplicateCase.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
    ]);

    const rows = await enrichDuplicateCases(cases);
    return res.json({ total, take, skip, rows, filters: { status, q } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.get("/duplicate-cases/:id", requireAuth, requireModule("CLINICAL"), async (req, res) => {
  try {
    if (!canReviewDuplicateCases(req)) return res.status(403).json({ message: "Forbidden" });

    const scope = await getScope(req);
    const where = { id: req.params.id, ...duplicateCaseScopeWhere(scope) };
    const record = await prisma.duplicateCase.findFirst({ where });
    if (!record) return res.status(404).json({ message: "Duplicate case not found" });

    const rows = await enrichDuplicateCases([record]);
    return res.json(rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.patch("/duplicate-cases/:id/resolve", requireAuth, requireModule("CLINICAL"), async (req, res) => {
  try {
    if (!canResolveDuplicateCases(req)) return res.status(403).json({ message: "Forbidden" });

    const action = req.body?.action || req.body?.resolutionAction;
    const nextStatus = mapDuplicateResolutionActionToStatus(action);
    if (!nextStatus) {
      return res.status(400).json({
        message: "Invalid action. Use NOT_DUPLICATE, DUPLICATE, TRANSFER, MERGE, UNDER_REVIEW, or CLOSE.",
      });
    }

    const scope = await getScope(req);
    const existing = await prisma.duplicateCase.findFirst({
      where: { id: req.params.id, ...duplicateCaseScopeWhere(scope) },
    });
    if (!existing) return res.status(404).json({ message: "Duplicate case not found" });

    const note = req.body?.note ?? req.body?.resolutionNote;
    const updated = await prisma.duplicateCase.update({
      where: { id: existing.id },
      data: {
        status: nextStatus,
        resolutionAction: String(action || "").trim().toUpperCase(),
        resolutionNote: note ? String(note).trim() : null,
        resolvedByUserId: nextStatus === "UNDER_REVIEW" ? null : req.user.id,
        resolvedAt: nextStatus === "UNDER_REVIEW" ? null : new Date(),
      },
    });

    const rows = await enrichDuplicateCases([updated]);
    return res.json({ message: "Duplicate case updated", case: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// -----------------------------------------------------------------------------
// GET /api/dashboard/programme-map?implementationId=&programIds=a,b&from=&to=
// Programme map for countries tracking children in Anchor (Kenya): per facility,
// admissions in the period, children in treatment now, missed appointments,
// discharges by outcome in the period and sachets dispensed in the period, with
// the facility's GPS position. Same shape as /api/dhis2-children/map.
// -----------------------------------------------------------------------------
// Exit outcomes of the discharge assessment, grouped like the DHIS2 programmes.
const KENYA_OUTCOMES = [
  ["cured", /achieved normal/i],
  ["died", /died|death/i],
  ["defaulted", /lost to follow|default/i],
  ["nonResponse", /deteriorat|not achieved|non.?respon/i],
];
const exitGroup = (o) => {
  const text = String(o || "");
  if (/not achieved/i.test(text)) return "nonResponse";
  return KENYA_OUTCOMES.find(([, re]) => re.test(text))?.[0] || "otherExits";
};
const PROGRAM_CODES = { SQLNS: "SQ-LNS" };

router.get("/programme-map", requireAuth, requireModule("CLINICAL"), async (req, res) => {
  try {
    const scope = await getScope(req);
    // Facilities in view. A Super Admin without a country sees the countries that track children in Anchor.
    const facilityWhere = { type: "FACILITY" };
    if (scope.mode === "ALL") {
      facilityWhere.implementation = { modules: { some: { module: "CLINICAL", isEnabled: true } } };
    } else {
      facilityWhere.id = { in: scope.facilityIdsFacilitiesOnly };
    }
    const facilities = await prisma.facility.findMany({
      where: facilityWhere,
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
      orderBy: { name: "asc" },
    });
    const facilityIds = facilities.map((f) => f.id);

    const parseDay = (v, end) => {
      if (!v) return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
      return d;
    };
    const from = parseDay(req.query.from, false);
    const to = parseDay(req.query.to, true);
    const inPeriod = (d) => !!d && (!from || d >= from) && (!to || d <= to);

    const allPrograms = facilityIds.length
      ? (await prisma.child.findMany({ where: { facilityId: { in: facilityIds } }, select: { program: true }, distinct: ["program"] })).map((r) => r.program)
      : [];
    const programs = allPrograms.sort().map((p) => ({ id: p, code: PROGRAM_CODES[p] || p, name: PROGRAM_CODES[p] || p }));
    const wanted = String(req.query.programIds || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const programIds = wanted.length ? allPrograms.filter((p) => wanted.includes(p)) : allPrograms;

    const children = facilityIds.length && programIds.length
      ? await prisma.child.findMany({
          where: { facilityId: { in: facilityIds }, program: { in: programIds } },
          select: {
            id: true,
            facilityId: true,
            program: true,
            enrollmentDate: true,
            inDepthAssessments: { where: { assessmentType: "DISCHARGE" }, select: { assessmentDate: true, data: true } },
            visits: { orderBy: { visitDate: "desc" }, take: 1, select: { nextAppointmentDate: true } },
          },
        })
      : [];

    const today = startOfDay(new Date());
    const sites = new Map();
    const slot = (facilityId, program) => {
      const site = sites.get(facilityId);
      site.programs[program] = site.programs[program] || { admissions: 0, inTreatment: 0, missed: 0, cured: 0, died: 0, defaulted: 0, nonResponse: 0, otherExits: 0 };
      return site.programs[program];
    };
    const byId = new Map(facilities.map((f) => [f.id, f]));
    for (const c of children) {
      if (!sites.has(c.facilityId)) {
        const f = byId.get(c.facilityId);
        sites.set(c.facilityId, {
          key: f.id,
          code: f.code,
          name: f.name,
          payam: null,
          county: null,
          state: null,
          latitude: f.latitude === null ? null : Number(f.latitude),
          longitude: f.longitude === null ? null : Number(f.longitude),
          inAnchor: true,
          programs: {},
          given: [],
        });
      }
      const x = slot(c.facilityId, c.program);
      if (inPeriod(c.enrollmentDate)) x.admissions += 1;
      const discharge = c.inDepthAssessments[0];
      if (discharge) {
        const exit = discharge.data?.exit || {};
        const exitDate = exit.exitDate ? parseDay(exit.exitDate, false) : discharge.assessmentDate;
        if (inPeriod(exitDate || discharge.assessmentDate)) x[exitGroup(exit.outcome)] += 1;
      } else {
        x.inTreatment += 1;
        const next = c.visits[0]?.nextAppointmentDate;
        if (next && startOfDay(next) < today) x.missed += 1;
      }
    }

    // Sachets dispensed in the period, by the child's facility and program.
    if (children.length) {
      const given = await prisma.$queryRaw`
        SELECT c.facilityId AS facilityId, c.program AS program, SUM(d.quantitySachets) AS amount
        FROM \`Dispense\` d
        JOIN \`ChildVisit\` v ON v.id = d.visitId
        JOIN \`Child\` c ON c.id = v.childId
        WHERE c.facilityId IN (${Prisma.join([...sites.keys()])})
          AND c.program IN (${Prisma.join(programIds)})
          ${from ? Prisma.sql`AND v.visitDate >= ${from}` : Prisma.empty}
          ${to ? Prisma.sql`AND v.visitDate <= ${to}` : Prisma.empty}
        GROUP BY c.facilityId, c.program`;
      for (const r of given) {
        const site = sites.get(r.facilityId);
        if (site && Number(r.amount)) site.given.push({ programConfigId: r.program, commodity: PROGRAM_CODES[r.program] || r.program, unit: "sachets", amount: Number(r.amount) });
      }
    }

    const idleSites = facilities
      .filter((f) => !sites.has(f.id))
      .map((f) => ({ name: f.name, code: f.code, latitude: f.latitude === null ? null : Number(f.latitude), longitude: f.longitude === null ? null : Number(f.longitude) }));

    return res.json({
      period: { from: req.query.from || null, to: req.query.to || null },
      programs: programs.map((p) => ({ ...p, selected: programIds.includes(p.id) })),
      sites: [...sites.values()],
      idleSites,
      gpsIssues: [],
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
