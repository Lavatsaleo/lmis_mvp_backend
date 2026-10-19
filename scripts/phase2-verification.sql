-- Phase 2A-2C verification helpers (read-only)
SELECT id, code, name, reportingCurrencyCode FROM Implementation;

SELECT id, code, name, type, stockLocationType, parentStockLocationId,
       capacityMetricTonnes, implementationId
FROM Facility
ORDER BY type, name;

SELECT id, code, name, baseUnitName, packUnitName, unitsPerPack,
       grossPackWeightKg, defaultUnitValue, defaultCurrencyCode, implementationId
FROM Product
ORDER BY name;

SELECT id, productId, batchNo, unitValue, currencyCode,
       valuationBasis, sourceType, sourceReference
FROM ProductBatchValuation
ORDER BY createdAt DESC;
