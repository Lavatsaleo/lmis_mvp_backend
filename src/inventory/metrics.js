function num(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createMeasure(reportingCurrencyCode = "USD") {
  return {
    baseUnits: 0,
    metricTonnes: 0,
    valueByCurrency: {},
    reportingCurrencyCode,
    reportingValue: 0,
    missingWeightBaseUnits: 0,
    missingValueBaseUnits: 0,
    foreignCurrencyBaseUnits: 0,
  };
}

function addValue(bucket, currency, amount, qty, reportingCurrencyCode) {
  if (amount == null || !Number.isFinite(amount)) {
    bucket.missingValueBaseUnits += qty;
    return;
  }
  const code = String(currency || reportingCurrencyCode || "USD").toUpperCase();
  bucket.valueByCurrency[code] = (bucket.valueByCurrency[code] || 0) + amount;
  if (code === reportingCurrencyCode) bucket.reportingValue += amount;
  else bucket.foreignCurrencyBaseUnits += qty;
}

function addQuantity(bucket, {
  quantity,
  unitWeightKg,
  unitValue,
  currencyCode,
  reportingCurrencyCode,
}) {
  const qty = num(quantity);
  if (qty <= 0) return;
  bucket.baseUnits += qty;

  if (unitWeightKg == null || !Number.isFinite(unitWeightKg)) {
    bucket.missingWeightBaseUnits += qty;
  } else {
    bucket.metricTonnes += (qty * unitWeightKg) / 1000;
  }

  addValue(
    bucket,
    currencyCode,
    unitValue == null ? null : qty * unitValue,
    qty,
    reportingCurrencyCode
  );
}

function finalizeMeasure(bucket) {
  const round = (n, digits = 3) => Number(Number(n || 0).toFixed(digits));
  const valueByCurrency = {};
  for (const [currency, amount] of Object.entries(bucket.valueByCurrency || {})) {
    valueByCurrency[currency] = round(amount, 2);
  }

  return {
    baseUnits: round(bucket.baseUnits, 3),
    metricTonnes: round(bucket.metricTonnes, 4),
    weightComplete: bucket.missingWeightBaseUnits <= 0,
    missingWeightBaseUnits: round(bucket.missingWeightBaseUnits, 3),
    valueByCurrency,
    reportingCurrencyCode: bucket.reportingCurrencyCode,
    reportingValue: round(bucket.reportingValue, 2),
    valueComplete:
      bucket.missingValueBaseUnits <= 0 && bucket.foreignCurrencyBaseUnits <= 0,
    missingValueBaseUnits: round(bucket.missingValueBaseUnits, 3),
    foreignCurrencyBaseUnits: round(bucket.foreignCurrencyBaseUnits, 3),
  };
}

function unitEconomics(product, batchNo) {
  const packUnits = Math.max(1, num(product?.unitsPerPack, 600));
  const grossKg = product?.grossPackWeightKg == null ? null : num(product.grossPackWeightKg, NaN);
  const unitWeightKg = grossKg == null || !Number.isFinite(grossKg) ? null : grossKg / packUnits;

  const valuations = Array.isArray(product?.batchValuations) ? product.batchValuations : [];
  const batchValuation = valuations.find((v) => String(v.batchNo) === String(batchNo));

  if (batchValuation) {
    return {
      unitWeightKg,
      unitValue: num(batchValuation.unitValue, NaN),
      currencyCode: batchValuation.currencyCode || product.defaultCurrencyCode || "USD",
      valuationSource: "BATCH",
    };
  }

  if (product?.defaultUnitValue != null) {
    return {
      unitWeightKg,
      unitValue: num(product.defaultUnitValue, NaN),
      currencyCode: product.defaultCurrencyCode || "USD",
      valuationSource: "PRODUCT_DEFAULT",
    };
  }

  return {
    unitWeightKg,
    unitValue: null,
    currencyCode: product?.defaultCurrencyCode || "USD",
    valuationSource: "MISSING",
  };
}

module.exports = {
  num,
  createMeasure,
  addQuantity,
  finalizeMeasure,
  unitEconomics,
};
