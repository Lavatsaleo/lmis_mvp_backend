const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { requireAdmin, isCountryAdmin } = require("../auth/access");
const { requestedImplementationId } = require("../inventory/scope");

const VALUATION_BASES = new Set([
  "PURCHASE_COST",
  "DONOR_DECLARED_VALUE",
  "REPLACEMENT_COST",
  "ESTIMATED_VALUE",
]);
const SOURCE_TYPES = new Set([
  "PURCHASE",
  "IN_KIND_DONATION",
  "TRANSFER",
  "RETURN",
  "OPENING_BALANCE",
  "OTHER",
]);

function numberOrNull(value, field, { min = 0, positive = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || (positive ? n <= 0 : n < min)) {
    const e = new Error(`${field} must be ${positive ? "a positive" : `at least ${min}`} number`);
    e.status = 400;
    throw e;
  }
  return n;
}

// Pack size is required to be a positive whole number; blank/null is rejected
// (Math.round(null) would silently store 0).
// Cartons per pallet: whole number 1-1000, or null to clear.
function cartonsPerPallet(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    const e = new Error("cartonsPerPallet must be a whole number between 1 and 1000");
    e.status = 400;
    throw e;
  }
  return n;
}

function packSize(value) {
  const n = numberOrNull(value, "unitsPerPack", { positive: true });
  if (n === null) {
    const e = new Error("unitsPerPack must be a positive number");
    e.status = 400;
    throw e;
  }
  return Math.round(n);
}

// Accept real booleans and the strings forms send ("true"/"false", "1"/"0").
function toBool(value) {
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function boolOrDefault(value, fallback) {
  return value === undefined ? fallback : toBool(value);
}

function serializeProduct(product) {
  return {
    ...product,
    grossPackWeightKg: product.grossPackWeightKg == null ? null : Number(product.grossPackWeightKg),
    defaultUnitValue: product.defaultUnitValue == null ? null : Number(product.defaultUnitValue),
    batchValuations: Array.isArray(product.batchValuations)
      ? product.batchValuations.map((v) => ({ ...v, unitValue: Number(v.unitValue) }))
      : product.batchValuations,
  };
}

async function assertProductAccess(req, productId) {
  const product = await prisma.product.findUnique({ where: { id: String(productId) } });
  if (!product) {
    const e = new Error("Product not found");
    e.status = 404;
    throw e;
  }
  if (req.user.role !== "SUPER_ADMIN" && product.implementationId !== req.user.implementationId) {
    const e = new Error("Forbidden");
    e.status = 403;
    throw e;
  }
  return product;
}

// GET /api/products
router.get("/", requireAuth, async (req, res) => {
  try {
    const implementationId = requestedImplementationId(req);
    if (!implementationId) return res.json([]);
    const rows = await prisma.product.findMany({
      where: {
        implementationId,
        ...(String(req.query.includeInactive || "").toLowerCase() === "true" ? {} : { isActive: true }),
      },
      include: {
        batchValuations: { orderBy: [{ batchNo: "asc" }] },
      },
      orderBy: [{ name: "asc" }],
    });
    return res.json(rows.map(serializeProduct));
  } catch (err) {
    console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// POST /api/products - generic configurable product creation.
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.code || !body.name) return res.status(400).json({ message: "code and name are required" });

    // A COUNTRY_ADMIN always configures their own implementation.
    const implementationId = isCountryAdmin(req.user)
      ? String(req.user.implementationId)
      : body.implementationId
      ? String(body.implementationId)
      : requestedImplementationId(req);
    if (!implementationId) return res.status(400).json({ message: "implementationId is required" });

    const existing = await prisma.product.findUnique({ where: { code: String(body.code).trim() } });
    if (existing) {
      return res.status(409).json({
        message: `Product code "${body.code}" already exists. Product codes are still globally unique in this compatibility phase.`,
        productId: existing.id,
      });
    }

    const implementation = await prisma.implementation.findUnique({
      where: { id: implementationId },
      select: { id: true, isActive: true },
    });
    if (!implementation || !implementation.isActive) {
      return res.status(400).json({ message: "implementationId not found or inactive" });
    }

    const unitsPerPack = body.unitsPerPack === undefined ? 600 : packSize(body.unitsPerPack);

    const created = await prisma.product.create({
      data: {
        code: String(body.code).trim(),
        name: String(body.name).trim(),
        implementationId,
        baseUnitName: String(body.baseUnitName || "Sachet").trim(),
        packUnitName: String(body.packUnitName || "Box").trim(),
        unitsPerPack,
        grossPackWeightKg: numberOrNull(body.grossPackWeightKg, "grossPackWeightKg", { positive: true }),
        cartonsPerPallet: cartonsPerPallet(body.cartonsPerPallet),
        defaultUnitValue: numberOrNull(body.defaultUnitValue, "defaultUnitValue", { min: 0 }),
        defaultCurrencyCode: String(body.defaultCurrencyCode || "USD").trim().toUpperCase(),
        trackBatch: boolOrDefault(body.trackBatch, true),
        trackExpiry: boolOrDefault(body.trackExpiry, true),
        isActive: boolOrDefault(body.isActive, true),
      },
    });
    return res.status(201).json(serializeProduct(created));
  } catch (err) {
    // Two admins creating the same code at once: the unique index catches it.
    if (err?.code === "P2002") return res.status(409).json({ message: `Product code "${req.body?.code}" already exists` });
    console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// PATCH /api/products/:id
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const existing = await assertProductAccess(req, req.params.id);
    const body = req.body || {};
    const data = {};

    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.baseUnitName !== undefined) data.baseUnitName = String(body.baseUnitName).trim();
    if (body.packUnitName !== undefined) data.packUnitName = String(body.packUnitName).trim();
    if (body.unitsPerPack !== undefined) {
      data.unitsPerPack = packSize(body.unitsPerPack);
    }
    if (body.cartonsPerPallet !== undefined) data.cartonsPerPallet = cartonsPerPallet(body.cartonsPerPallet);
    if (body.grossPackWeightKg !== undefined) {
      data.grossPackWeightKg = numberOrNull(body.grossPackWeightKg, "grossPackWeightKg", { positive: true });
    }
    if (body.defaultUnitValue !== undefined) {
      data.defaultUnitValue = numberOrNull(body.defaultUnitValue, "defaultUnitValue", { min: 0 });
    }
    if (body.defaultCurrencyCode !== undefined) {
      data.defaultCurrencyCode = String(body.defaultCurrencyCode).trim().toUpperCase();
    }
    if (body.trackBatch !== undefined) data.trackBatch = toBool(body.trackBatch);
    if (body.trackExpiry !== undefined) data.trackExpiry = toBool(body.trackExpiry);
    if (body.isActive !== undefined) data.isActive = toBool(body.isActive);

    const updated = await prisma.product.update({
      where: { id: existing.id },
      data,
      include: { batchValuations: true },
    });
    return res.json(serializeProduct(updated));
  } catch (err) {
    console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// PUT /api/products/:id/batches/:batchNo/valuation
// Accepts either unitValue OR packValue. packValue is converted to base-unit value.
router.put(
  "/:id/batches/:batchNo/valuation",
  requireAuth,
  requireRole("SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const product = await assertProductAccess(req, req.params.id);
      const body = req.body || {};
      const batchNo = String(req.params.batchNo).trim();
      if (!batchNo) return res.status(400).json({ message: "batchNo is required" });

      let unitValue = body.unitValue !== undefined
        ? numberOrNull(body.unitValue, "unitValue", { min: 0 })
        : null;
      if (unitValue == null && body.packValue !== undefined) {
        const packValue = numberOrNull(body.packValue, "packValue", { min: 0 });
        unitValue = packValue / Math.max(1, Number(product.unitsPerPack || 1));
      }
      if (unitValue == null) {
        return res.status(400).json({ message: "Provide unitValue or packValue" });
      }

      const valuationBasis = String(body.valuationBasis || "PURCHASE_COST").trim().toUpperCase();
      if (!VALUATION_BASES.has(valuationBasis)) {
        return res.status(400).json({ message: "Invalid valuationBasis" });
      }
      const sourceType = String(body.sourceType || "PURCHASE").trim().toUpperCase();
      if (!SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ message: "Invalid sourceType" });
      }

      const implementationId = product.implementationId || req.user.implementationId;
      if (!implementationId) return res.status(400).json({ message: "Product has no implementation" });

      const row = await prisma.productBatchValuation.upsert({
        where: { productId_batchNo: { productId: product.id, batchNo } },
        create: {
          implementationId,
          productId: product.id,
          batchNo,
          unitValue,
          currencyCode: String(body.currencyCode || product.defaultCurrencyCode || "USD").trim().toUpperCase(),
          valuationBasis,
          sourceType,
          sourceReference: body.sourceReference ? String(body.sourceReference).trim() : null,
          note: body.note ? String(body.note).trim() : null,
        },
        update: {
          unitValue,
          currencyCode: String(body.currencyCode || product.defaultCurrencyCode || "USD").trim().toUpperCase(),
          valuationBasis,
          sourceType,
          sourceReference: body.sourceReference ? String(body.sourceReference).trim() : null,
          note: body.note ? String(body.note).trim() : null,
        },
      });

      return res.json({ ...row, unitValue: Number(row.unitValue) });
    } catch (err) {
      console.error(err);
      return res.status(err.status || 500).json({ message: err.message || "Server error" });
    }
  }
);

module.exports = router;
