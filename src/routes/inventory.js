const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { resolveLocationScope } = require("../inventory/scope");
const {
  num,
  createMeasure,
  addQuantity,
  finalizeMeasure,
  unitEconomics,
} = require("../inventory/metrics");

function key(parts) {
  return parts.map((x) => String(x ?? "")).join("::");
}

function makeGroupMap() {
  return new Map();
}

function getGroup(map, id, meta, reportingCurrencyCode) {
  if (!map.has(id)) {
    map.set(id, {
      ...meta,
      currentStock: createMeasure(reportingCurrencyCode),
      usedStock: createMeasure(reportingCurrencyCode),
      inTransit: createMeasure(reportingCurrencyCode),
      expiringWithin90Days: createMeasure(reportingCurrencyCode),
    });
  }
  return map.get(id);
}

function finalizeGroup(row) {
  return {
    ...row,
    currentStock: finalizeMeasure(row.currentStock),
    usedStock: finalizeMeasure(row.usedStock),
    inTransit: finalizeMeasure(row.inTransit),
    expiringWithin90Days: finalizeMeasure(row.expiringWithin90Days),
  };
}

// GET /api/inventory/summary?locationId=...&implementationId=...
//
// This is intentionally a compatibility projection over the existing Kenya Box
// model. It gives us quantity + MT + value reporting now without changing the
// working dispensing workflow. Phase 2D/2G will move future transfers and
// pharmacy dispensing onto the generic inventory ledger.
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const requestedLocationId = req.query.locationId ? String(req.query.locationId) : null;
    const scope = await resolveLocationScope(req, { requestedLocationId });
    if (!scope.implementationId) {
      // Same shape as a normal response, just empty.
      const empty = () => finalizeMeasure(createMeasure("USD"));
      return res.json({
        implementation: null,
        reportingCurrencyCode: "USD",
        scope: { requestedLocationId, locationIds: [] },
        currentStock: empty(),
        usedStock: empty(),
        inTransit: empty(),
        expiringWithin90Days: empty(),
        byProduct: [],
        byLocation: [],
        configurationWarnings: { productsMissingWeight: [], productsOrBatchesMissingValue: [] },
      });
    }

    if (requestedLocationId && scope.locationIds.length === 0) {
      return res.status(403).json({ message: "Location is outside your permitted scope" });
    }

    const implementation = await prisma.implementation.findUnique({
      where: { id: scope.implementationId },
      select: { id: true, code: true, name: true, reportingCurrencyCode: true },
    });
    if (!implementation) return res.status(404).json({ message: "Implementation not found" });

    const reportingCurrencyCode = String(implementation.reportingCurrencyCode || "USD").toUpperCase();
    const allowedLocations = new Set(scope.locationIds);

    const boxes = await prisma.box.findMany({
      where: {
        status: { not: "VOID" },
        product: { implementationId: scope.implementationId },
      },
      select: {
        id: true,
        boxUid: true,
        batchNo: true,
        expiryDate: true,
        status: true,
        sachetsPerBox: true,
        sachetsRemaining: true,
        currentFacilityId: true,
        product: {
          select: {
            id: true,
            code: true,
            name: true,
            baseUnitName: true,
            packUnitName: true,
            unitsPerPack: true,
            grossPackWeightKg: true,
            defaultUnitValue: true,
            defaultCurrencyCode: true,
            batchValuations: {
              select: {
                batchNo: true,
                unitValue: true,
                currencyCode: true,
                valuationBasis: true,
                sourceType: true,
              },
            },
          },
        },
      },
    });

    const inTransitBoxIds = boxes.filter((b) => b.status === "IN_TRANSIT").map((b) => b.id);
    const openShipmentItems = inTransitBoxIds.length
      ? await prisma.shipmentItem.findMany({
          where: {
            boxId: { in: inTransitBoxIds },
            shipment: { status: "DISPATCHED" },
          },
          select: {
            boxId: true,
            shipment: {
              select: {
                id: true,
                manifestNo: true,
                fromWarehouseId: true,
                toFacilityId: true,
                dispatchedAt: true,
              },
            },
          },
        })
      : [];
    const transitByBox = new Map(openShipmentItems.map((x) => [x.boxId, x.shipment]));

    const overall = {
      currentStock: createMeasure(reportingCurrencyCode),
      usedStock: createMeasure(reportingCurrencyCode),
      inTransit: createMeasure(reportingCurrencyCode),
      expiringWithin90Days: createMeasure(reportingCurrencyCode),
    };
    const byProduct = makeGroupMap();
    const byLocation = makeGroupMap();

    // Pre-populate all accessible locations so an empty warehouse still appears
    // with its full available capacity. This is important for warehouse-space
    // planning, not just stock reporting.
    for (const location of scope.locations) {
      if (!allowedLocations.has(location.id)) continue;
      getGroup(
        byLocation,
        location.id,
        {
          location: {
            id: location.id,
            code: location.code,
            name: location.name,
            type: location.type,
            stockLocationType: location.stockLocationType,
            capacityMetricTonnes:
              location.capacityMetricTonnes == null ? null : Number(location.capacityMetricTonnes),
          },
        },
        reportingCurrencyCode
      );
    }

    const now = Date.now();
    const expiryLimit = now + 90 * 24 * 60 * 60 * 1000;

    const relevantBoxIds = [];

    for (const box of boxes) {
      const currentLocationId = box.currentFacilityId ? String(box.currentFacilityId) : null;
      const openShipment = transitByBox.get(box.id) || null;
      const transitInScope =
        box.status === "IN_TRANSIT" &&
        openShipment &&
        (allowedLocations.has(String(openShipment.fromWarehouseId)) ||
          allowedLocations.has(String(openShipment.toFacilityId)));
      const currentInScope = currentLocationId && allowedLocations.has(currentLocationId);

      if (!currentInScope && !transitInScope) continue;
      relevantBoxIds.push(box.id);

      const product = box.product;
      const perPack = Math.max(1, num(box.sachetsPerBox, num(product.unitsPerPack, 600)));
      const remaining = Math.max(0, Math.min(perPack, num(box.sachetsRemaining, perPack)));
      let used = Math.max(0, perPack - remaining);
      // Legacy whole-box dispense endpoint marked the box DISPENSED without
      // decrementing sachetsRemaining. Treat such a box as fully used.
      if (box.status === "DISPENSED" && used === 0) used = perPack;

      const economics = unitEconomics(product, box.batchNo);
      const measureArgs = {
        unitWeightKg: economics.unitWeightKg,
        unitValue: Number.isFinite(economics.unitValue) ? economics.unitValue : null,
        currencyCode: economics.currencyCode,
        reportingCurrencyCode,
      };

      const productGroup = getGroup(
        byProduct,
        product.id,
        {
          product: {
            id: product.id,
            code: product.code,
            name: product.name,
            baseUnitName: product.baseUnitName,
            packUnitName: product.packUnitName,
            unitsPerPack: product.unitsPerPack,
          },
        },
        reportingCurrencyCode
      );

      if (currentInScope && ["IN_WAREHOUSE", "IN_FACILITY"].includes(box.status)) {
        addQuantity(overall.currentStock, { quantity: remaining, ...measureArgs });
        addQuantity(productGroup.currentStock, { quantity: remaining, ...measureArgs });

        const location = scope.locations.find((x) => x.id === currentLocationId);
        if (location) {
          const locationGroup = getGroup(
            byLocation,
            location.id,
            {
              location: {
                id: location.id,
                code: location.code,
                name: location.name,
                type: location.type,
                stockLocationType: location.stockLocationType,
                capacityMetricTonnes:
                  location.capacityMetricTonnes == null ? null : Number(location.capacityMetricTonnes),
              },
            },
            reportingCurrencyCode
          );
          addQuantity(locationGroup.currentStock, { quantity: remaining, ...measureArgs });

          const exp = new Date(box.expiryDate).getTime();
          if (Number.isFinite(exp) && exp >= now && exp <= expiryLimit) {
            addQuantity(overall.expiringWithin90Days, { quantity: remaining, ...measureArgs });
            addQuantity(productGroup.expiringWithin90Days, { quantity: remaining, ...measureArgs });
            addQuantity(locationGroup.expiringWithin90Days, { quantity: remaining, ...measureArgs });
          }
        }
      }

      if (currentInScope && used > 0) {
        addQuantity(overall.usedStock, { quantity: used, ...measureArgs });
        addQuantity(productGroup.usedStock, { quantity: used, ...measureArgs });
        const location = scope.locations.find((x) => x.id === currentLocationId);
        if (location) {
          const locationGroup = getGroup(
            byLocation,
            location.id,
            {
              location: {
                id: location.id,
                code: location.code,
                name: location.name,
                type: location.type,
                stockLocationType: location.stockLocationType,
                capacityMetricTonnes:
                  location.capacityMetricTonnes == null ? null : Number(location.capacityMetricTonnes),
              },
            },
            reportingCurrencyCode
          );
          addQuantity(locationGroup.usedStock, { quantity: used, ...measureArgs });
        }
      }

      if (transitInScope) {
        addQuantity(overall.inTransit, { quantity: remaining, ...measureArgs });
        addQuantity(productGroup.inTransit, { quantity: remaining, ...measureArgs });

        // Attribute in-transit stock to the destination location for operational
        // visibility, while keeping it separate from available stock.
        const destination = scope.locations.find((x) => x.id === String(openShipment.toFacilityId));
        if (destination && allowedLocations.has(destination.id)) {
          const locationGroup = getGroup(
            byLocation,
            destination.id,
            {
              location: {
                id: destination.id,
                code: destination.code,
                name: destination.name,
                type: destination.type,
                stockLocationType: destination.stockLocationType,
                capacityMetricTonnes:
                  destination.capacityMetricTonnes == null ? null : Number(destination.capacityMetricTonnes),
              },
            },
            reportingCurrencyCode
          );
          addQuantity(locationGroup.inTransit, { quantity: remaining, ...measureArgs });
        }
      }
    }

    const byLocationFinal = [...byLocation.values()].map((row) => {
      const finalized = finalizeGroup(row);
      const capacity = finalized.location.capacityMetricTonnes;
      finalized.capacity = {
        capacityMetricTonnes: capacity,
        currentMetricTonnes: finalized.currentStock.metricTonnes,
        availableMetricTonnes:
          capacity == null || !finalized.currentStock.weightComplete
            ? null
            : Number(Math.max(0, capacity - finalized.currentStock.metricTonnes).toFixed(4)),
        utilizationPct:
          capacity == null || capacity <= 0 || !finalized.currentStock.weightComplete
            ? null
            : Number(((finalized.currentStock.metricTonnes / capacity) * 100).toFixed(2)),
        calculationComplete: capacity != null && finalized.currentStock.weightComplete,
      };
      return finalized;
    });

    return res.json({
      implementation,
      reportingCurrencyCode,
      scope: {
        requestedLocationId,
        locationIds: scope.locationIds,
      },
      currentStock: finalizeMeasure(overall.currentStock),
      usedStock: finalizeMeasure(overall.usedStock),
      inTransit: finalizeMeasure(overall.inTransit),
      expiringWithin90Days: finalizeMeasure(overall.expiringWithin90Days),
      byProduct: [...byProduct.values()].map(finalizeGroup),
      byLocation: byLocationFinal,
      configurationWarnings: {
        productsMissingWeight: [...byProduct.values()]
          .filter((x) => !finalizeMeasure(x.currentStock).weightComplete || !finalizeMeasure(x.usedStock).weightComplete)
          .map((x) => ({ id: x.product.id, code: x.product.code, name: x.product.name })),
        productsOrBatchesMissingValue: [...byProduct.values()]
          .filter((x) => !finalizeMeasure(x.currentStock).valueComplete || !finalizeMeasure(x.usedStock).valueComplete)
          .map((x) => ({ id: x.product.id, code: x.product.code, name: x.product.name })),
      },
      note:
        "Phase 2 compatibility projection: current/used quantities are calculated from the existing Box model. Future generic transfer and pharmacy transactions will move to the inventory ledger without changing this response contract.",
    });
  } catch (err) {
    console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;
