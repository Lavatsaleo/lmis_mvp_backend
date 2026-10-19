const assert = require("node:assert/strict");
const {
  createMeasure,
  addQuantity,
  finalizeMeasure,
  unitEconomics,
} = require("../src/inventory/metrics");

const product = {
  unitsPerPack: 600,
  grossPackWeightKg: 12,
  defaultUnitValue: 0.4,
  defaultCurrencyCode: "USD",
  batchValuations: [
    { batchNo: "B-001", unitValue: 0.5, currencyCode: "USD" },
  ],
};

const econ = unitEconomics(product, "B-001");
assert.equal(econ.unitWeightKg, 0.02);
assert.equal(econ.unitValue, 0.5);

const used = createMeasure("USD");
addQuantity(used, {
  quantity: 1200,
  unitWeightKg: econ.unitWeightKg,
  unitValue: econ.unitValue,
  currencyCode: econ.currencyCode,
  reportingCurrencyCode: "USD",
});
const out = finalizeMeasure(used);
assert.equal(out.baseUnits, 1200);
assert.equal(out.metricTonnes, 0.024);
assert.equal(out.reportingValue, 600);
assert.equal(out.weightComplete, true);
assert.equal(out.valueComplete, true);

const incomplete = createMeasure("USD");
addQuantity(incomplete, {
  quantity: 100,
  unitWeightKg: null,
  unitValue: null,
  currencyCode: "USD",
  reportingCurrencyCode: "USD",
});
const incompleteOut = finalizeMeasure(incomplete);
assert.equal(incompleteOut.weightComplete, false);
assert.equal(incompleteOut.valueComplete, false);
assert.equal(incompleteOut.missingWeightBaseUnits, 100);
assert.equal(incompleteOut.missingValueBaseUnits, 100);

console.log("Inventory metric tests passed");
