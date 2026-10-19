// Shared rules for the warehouse features (twin, purchase orders, receiving,
// reports): who can see or operate a warehouse, and what a box is worth.

const { countryWideImplementationId, locationWithDescendants, isSuperAdmin, isCountryAdmin } = require("../auth/access");
const { unitEconomics, num } = require("../inventory/metrics");

/**
 * Prisma `where` for the warehouses a user may look at, or null for none.
 * SUPER_ADMIN: all (optionally ?implementationId); COUNTRY_ADMIN / country-wide
 * VIEWER: their country; anyone on a warehouse: it and every warehouse below.
 */
async function visibleWarehouseWhere(req) {
  const base = { type: "WAREHOUSE" };
  if (isSuperAdmin(req.user)) {
    if (req.query?.implementationId) base.implementationId = String(req.query.implementationId);
    return base;
  }
  const countryId = countryWideImplementationId(req.user);
  if (countryId) return { ...base, implementationId: countryId };
  if (req.user.facilityType === "WAREHOUSE" && req.user.facilityId) {
    return { ...base, id: { in: await locationWithDescendants(req.user.facilityId) } };
  }
  return null;
}

/** Ids of the warehouses a user may look at (null = no restriction). */
async function visibleWarehouseIds(req, prisma) {
  const where = await visibleWarehouseWhere(req);
  if (!where) return [];
  if (isSuperAdmin(req.user) && !where.implementationId) return null;
  const rows = await prisma.facility.findMany({ where, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * May this user enter purchase orders for, and receive goods into, a
 * warehouse? SUPER_ADMIN anywhere; COUNTRY_ADMIN in their country; a
 * WAREHOUSE_OFFICER only into their own warehouse.
 */
function canOperateWarehouse(user, warehouse) {
  if (!warehouse || warehouse.type !== "WAREHOUSE") return false;
  if (isSuperAdmin(user)) return true;
  if (isCountryAdmin(user)) return !!user.implementationId && warehouse.implementationId === user.implementationId;
  if (user.role === "WAREHOUSE_OFFICER") return String(user.warehouseId || "") === String(warehouse.id);
  return false;
}

const OPERATOR_ROLES = ["SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"];

/**
 * Label policy per implementation: with MAIN_ONLY, QR labels are generated
 * only at main warehouses (where goods are first received); field bases get
 * labelled stock by transfer. Returns an error message or null.
 */
async function labelGenerationError(warehouse) {
  if (!warehouse?.implementationId) return null;
  const prisma = require("../lib/prisma");
  const impl = await prisma.implementation.findUnique({ where: { id: warehouse.implementationId }, select: { labelGenerationScope: true } });
  if (impl?.labelGenerationScope === "MAIN_ONLY" && warehouse.stockLocationType !== "CENTRAL_WAREHOUSE") {
    return "QR labels are generated at the main warehouse only in this country. Receive this stock by transfer from the main warehouse.";
  }
  return null;
}

/**
 * Value of one base unit (sachet, tablet) in a box, and its currency.
 * Stock received against a PO is valued at that PO line's price; older stock
 * falls back to the batch valuation / product default (as Inventory
 * Intelligence does). Needs box.purchaseOrderLine{unitPrice, purchaseOrder{currencyCode}}
 * and box.product{unitsPerPack, defaultUnitValue, defaultCurrencyCode, batchValuations}.
 */
function boxUnitValue(box) {
  const line = box.purchaseOrderLine;
  if (line && line.unitPrice != null) {
    const perPack = num(line.unitPrice, NaN);
    const units = Math.max(1, box.sachetsPerBox || box.product?.unitsPerPack || 1);
    return { unitValue: perPack / units, currencyCode: line.purchaseOrder?.currencyCode || "USD", source: "PO" };
  }
  const e = unitEconomics(box.product, box.batchNo);
  return { unitValue: e.unitValue, currencyCode: e.currencyCode, source: e.valuationSource };
}

/** Prisma select fragment with everything boxUnitValue needs. */
const BOX_VALUE_SELECT = {
  sachetsPerBox: true,
  sachetsRemaining: true,
  batchNo: true,
  purchaseOrderLine: { select: { unitPrice: true, purchaseOrder: { select: { currencyCode: true } } } },
};

const PRODUCT_VALUE_SELECT = {
  id: true,
  code: true,
  name: true,
  baseUnitName: true,
  packUnitName: true,
  unitsPerPack: true,
  grossPackWeightKg: true,
  cartonsPerPallet: true,
  defaultUnitValue: true,
  defaultCurrencyCode: true,
};

/** Product select including batch valuations (for fallback values). */
const productValueSelect = () => ({
  ...PRODUCT_VALUE_SELECT,
  batchValuations: { select: { batchNo: true, unitValue: true, currencyCode: true } },
});

/** Add an amount to a { CUR: amount } map, ignoring unknown values. */
function addMoney(map, currency, amount) {
  if (amount == null || !Number.isFinite(amount)) return false;
  const code = String(currency || "USD").toUpperCase();
  map[code] = (map[code] || 0) + amount;
  return true;
}

const roundMoney = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Number(v.toFixed(2))]));

module.exports = {
  visibleWarehouseWhere,
  visibleWarehouseIds,
  canOperateWarehouse,
  OPERATOR_ROLES,
  labelGenerationError,
  boxUnitValue,
  BOX_VALUE_SELECT,
  PRODUCT_VALUE_SELECT,
  productValueSelect,
  addMoney,
  roundMoney,
};
