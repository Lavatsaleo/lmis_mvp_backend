const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");

// ✅ QR helpers
const { writeA3Labels, sortBoxes } = require("../utils/labelSheet");

// ✅ Auth + RBAC
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { canOperateWarehouse, labelGenerationError } = require("../warehouse/common");


/**
 * POST /api/orders
 * Body: { orderNumber, donorName? }
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 */
router.post(
  "/",
  requireAuth,
  requireRole("SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderNumber, donorName } = req.body || {};
      if (!orderNumber) return res.status(400).json({ message: "orderNumber is required" });

      const existing = await prisma.order.findUnique({ where: { orderNumber } });
      if (existing) {
        if (donorName && !existing.donorName) {
          const updated = await prisma.order.update({
            where: { id: existing.id },
            data: { donorName },
          });
          return res.status(200).json({ message: "Order already exists (updated donorName)", order: updated });
        }
        return res.status(200).json({ message: "Order already exists", order: existing });
      }

      const data = { orderNumber };
      if (donorName) data.donorName = donorName;

      const order = await prisma.order.create({ data });
      return res.status(201).json(order);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * POST /api/orders/:orderId/boxes/generate
 * Body: { productCode, productName, batchNo, expiryDate, quantity, warehouseFacilityId, donorName?,
 *         baseUnitName?, packUnitName?, unitsPerPack?, grossPackWeightKg?,
 *         unitValue? | packValue?, currencyCode?, valuationBasis?, sourceType?, sourceReference? }
 * Header (recommended): X-Idempotency-Key — a retry with the same key returns the
 *   boxes already generated instead of creating a second set.
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 *
 * Box UID format:
 *   <ORDER_NUMBER>-<SEQUENCE>
 * Like below
 *   SPO-ISL-00884-001-1
 *   SPO-ISL-00884-001-2
 */
const VALUATION_BASES = new Set(["PURCHASE_COST", "DONOR_DECLARED_VALUE", "REPLACEMENT_COST", "ESTIMATED_VALUE"]);
const SOURCE_TYPES = new Set(["PURCHASE", "IN_KIND_DONATION", "TRANSFER", "RETURN", "OPENING_BALANCE", "OTHER"]);
const MAX_BOXES_PER_REQUEST = 5000;

// null when absent/blank; NaN when present but not a number.
function optionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return Number(value);
}

function nextBoxSequence(orderNumber, existingUids) {
  const prefix = `${orderNumber}-`;
  let max = 0;
  for (const uid of existingUids) {
    if (!uid.startsWith(prefix)) continue;
    const seq = Number(uid.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return Math.max(max, existingUids.length) + 1;
}

async function generationReplayResponse(order, idempotencyKey) {
  const boxes = await prisma.box.findMany({
    where: { orderId: order.id, generationRequestId: idempotencyKey },
    select: { boxUid: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { boxUid: "asc" }],
  });
  if (!boxes.length) return null;
  return {
    message: "Boxes generated (idempotent replay)",
    replayed: true,
    orderNumber: order.orderNumber,
    donorName: order.donorName || null,
    createdCount: boxes.length,
    sample: boxes.slice(0, 10).map((b) => b.boxUid),
  };
}

router.post(
  "/:orderId/boxes/generate",
  requireAuth,
  requireRole("SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const body = req.body || {};
      const {
        productCode, productName, expiryDate, quantity, warehouseFacilityId, donorName,
        baseUnitName, packUnitName, unitsPerPack, grossPackWeightKg,
        unitValue, packValue, currencyCode, valuationBasis, sourceType, sourceReference,
      } = body;
      // Trimmed once and used for both the boxes and the batch valuation, so the
      // valuation lookup (by exact batchNo) always matches.
      const batchNo = body.batchNo == null ? "" : String(body.batchNo).trim();

      if (!productCode || !productName || !batchNo || !expiryDate || !quantity || !warehouseFacilityId) {
        return res.status(400).json({
          message: "productCode, productName, batchNo, expiryDate, quantity, warehouseFacilityId are required",
        });
      }

      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: "quantity must be a positive integer" });
      }
      if (qty > MAX_BOXES_PER_REQUEST) {
        return res.status(400).json({ message: `quantity cannot exceed ${MAX_BOXES_PER_REQUEST} boxes per request` });
      }

      const exp = new Date(expiryDate);
      if (isNaN(exp.getTime())) {
        return res.status(400).json({ message: "expiryDate must be a valid date (YYYY-MM-DD)" });
      }

      // ---- Validate every optional field before anything is written ----
      const unitsNum = optionalNumber(unitsPerPack);
      const parsedUnits = unitsNum === null ? null : Math.round(unitsNum);
      if (parsedUnits !== null && (!Number.isFinite(parsedUnits) || parsedUnits <= 0)) {
        return res.status(400).json({ message: "unitsPerPack must be a positive number" });
      }

      const parsedWeight = optionalNumber(grossPackWeightKg);
      if (parsedWeight !== null && (!Number.isFinite(parsedWeight) || parsedWeight <= 0)) {
        return res.status(400).json({ message: "grossPackWeightKg must be a positive number" });
      }

      // A blank/null unitValue means "not provided" (falls back to packValue),
      // never zero.
      const unitValueNum = optionalNumber(unitValue);
      const packValueNum = optionalNumber(packValue);
      if (unitValueNum !== null && (!Number.isFinite(unitValueNum) || unitValueNum < 0)) {
        return res.status(400).json({ message: "unitValue must be a non-negative number" });
      }
      if (packValueNum !== null && (!Number.isFinite(packValueNum) || packValueNum < 0)) {
        return res.status(400).json({ message: "packValue must be a non-negative number" });
      }
      const wantsValuation = unitValueNum !== null || packValueNum !== null;

      const basis = String(valuationBasis || "PURCHASE_COST").trim().toUpperCase();
      const source = String(sourceType || "PURCHASE").trim().toUpperCase();
      if (wantsValuation && !VALUATION_BASES.has(basis)) return res.status(400).json({ message: "Invalid valuationBasis" });
      if (wantsValuation && !SOURCE_TYPES.has(source)) return res.status(400).json({ message: "Invalid sourceType" });

      const currency = currencyCode ? String(currencyCode).trim().toUpperCase() : null;

      const idemRaw = req.header("X-Idempotency-Key");
      const idempotencyKey = idemRaw && String(idemRaw).trim().length <= 191 ? String(idemRaw).trim() : null;

      const [order, warehouse] = await Promise.all([
        prisma.order.findUnique({ where: { id: orderId } }),
        prisma.facility.findUnique({ where: { id: warehouseFacilityId } }),
      ]);

      if (!order) return res.status(404).json({ message: "Order not found" });
      if (!warehouse) return res.status(404).json({ message: "Warehouse facility not found" });
      if (warehouse.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "warehouseFacilityId must be a WAREHOUSE" });
      }
      if (!canOperateWarehouse(req.user, warehouse)) {
        return res.status(403).json({ message: "You can only generate boxes into your own warehouse" });
      }
      const labelPolicy = await labelGenerationError(warehouse);
      if (labelPolicy) return res.status(403).json({ code: "LABELS_MAIN_WAREHOUSE_ONLY", message: labelPolicy });

      if (donorName && order.donorName && order.donorName !== donorName) {
        return res.status(400).json({
          message: `Order already has donorName="${order.donorName}". You sent "${donorName}".`,
        });
      }

      // Retry of a request that already completed (e.g. the client timed out
      // waiting for the response): return what was generated.
      if (idempotencyKey) {
        const replay = await generationReplayResponse(order, idempotencyKey);
        if (replay) return res.json(replay);
      }

      const effectiveImplementationId = warehouse.implementationId || req.user.implementationId || null;

      const existingProduct = await prisma.product.findUnique({ where: { code: productCode } });
      if (
        existingProduct &&
        effectiveImplementationId &&
        existingProduct.implementationId &&
        existingProduct.implementationId !== effectiveImplementationId
      ) {
        return res.status(409).json({
          message: `Product code "${productCode}" already belongs to a different implementation.`,
        });
      }

      const valuationImplementationId = existingProduct?.implementationId || effectiveImplementationId;
      if (wantsValuation && !valuationImplementationId) {
        return res.status(400).json({ message: "Warehouse/product has no implementation; cannot store batch valuation" });
      }

      // ---- All writes in one transaction ----
      const result = await prisma.$transaction(
        async (tx) => {
          // Serialise generations for this order: box UIDs are sequential per
          // order, and the idempotency check below must see a finished request.
          await tx.$queryRaw`SELECT id FROM \`Order\` WHERE id = ${order.id} FOR UPDATE`;

          if (idempotencyKey) {
            const prior = await tx.box.findFirst({
              where: { orderId: order.id, generationRequestId: idempotencyKey },
              select: { id: true },
            });
            if (prior) return { replay: true };
          }

          if (donorName && !order.donorName) {
            await tx.order.update({ where: { id: order.id }, data: { donorName } });
          }

          let product;
          if (existingProduct) {
            const productUpdate = {
              name: productName,
              implementationId: existingProduct.implementationId || effectiveImplementationId,
            };
            if (baseUnitName) productUpdate.baseUnitName = String(baseUnitName).trim();
            if (packUnitName) productUpdate.packUnitName = String(packUnitName).trim();
            if (parsedUnits !== null) productUpdate.unitsPerPack = parsedUnits;
            if (parsedWeight !== null) productUpdate.grossPackWeightKg = parsedWeight;
            product = await tx.product.update({ where: { id: existingProduct.id }, data: productUpdate });
          } else {
            product = await tx.product.create({
              data: {
                code: productCode,
                name: productName,
                implementationId: effectiveImplementationId,
                baseUnitName: baseUnitName ? String(baseUnitName).trim() : "Sachet",
                packUnitName: packUnitName ? String(packUnitName).trim() : "Box",
                unitsPerPack: parsedUnits ?? 600,
                grossPackWeightKg: parsedWeight,
                defaultCurrencyCode: currency || "USD",
              },
            });
          }

          // Optional batch valuation captured at the point stock is introduced.
          // packValue is converted to a base-unit value.
          if (wantsValuation) {
            const parsedUnitValue =
              unitValueNum !== null ? unitValueNum : packValueNum / Math.max(1, Number(product.unitsPerPack || 1));
            const valuation = {
              unitValue: parsedUnitValue,
              currencyCode: currency || product.defaultCurrencyCode || "USD",
              valuationBasis: basis,
              sourceType: source,
              sourceReference: sourceReference ? String(sourceReference).trim() : donorName || order.orderNumber || null,
            };
            await tx.productBatchValuation.upsert({
              where: { productId_batchNo: { productId: product.id, batchNo } },
              create: { implementationId: valuationImplementationId, productId: product.id, batchNo, ...valuation },
              update: valuation,
            });
          }

          // Link the boxes to a Donor record (matched by name, ignoring case;
          // created if new) so donor reports include stock entered this way.
          let donorId = null;
          const donorLabel = String(donorName || order.donorName || "").trim().replace(/\s+/g, " ");
          const donorImplementationId = product.implementationId || effectiveImplementationId;
          if (donorLabel && donorImplementationId) {
            const donor =
              (await tx.donor.findFirst({ where: { implementationId: donorImplementationId, name: donorLabel } })) ||
              (await tx.donor.create({ data: { implementationId: donorImplementationId, name: donorLabel } }));
            donorId = donor.id;
          }

          const existingUids = (
            await tx.box.findMany({ where: { orderId: order.id }, select: { boxUid: true } })
          ).map((b) => b.boxUid);
          const startSeq = nextBoxSequence(order.orderNumber, existingUids);

          // Legacy field names retained for mobile compatibility. The value is
          // driven by the configurable product pack size.
          const perBox = Math.max(1, Number(product.unitsPerPack || 600));
          const boxUids = Array.from({ length: qty }, (_, i) => `${order.orderNumber}-${startSeq + i}`);

          // Bulk inserts: one statement each instead of three per box, so large
          // orders finish well inside the transaction timeout.
          await tx.box.createMany({
            data: boxUids.map((boxUid) => ({
              boxUid,
              orderId: order.id,
              productId: product.id,
              batchNo,
              expiryDate: exp,
              status: "IN_WAREHOUSE",
              currentFacilityId: warehouse.id,
              sachetsPerBox: perBox,
              sachetsRemaining: perBox,
              generationRequestId: idempotencyKey,
              donorId,
            })),
          });

          const created = await tx.box.findMany({
            where: { orderId: order.id, boxUid: { in: boxUids } },
            select: { id: true },
          });

          await tx.boxEvent.createMany({
            data: created.flatMap((box) => [
              {
                boxId: box.id,
                type: "QR_CREATED",
                performedByUserId: req.user.id,
                toFacilityId: warehouse.id,
                note: `QR created for order ${order.orderNumber}`,
              },
              {
                boxId: box.id,
                type: "WAREHOUSE_RECEIVE",
                performedByUserId: req.user.id,
                toFacilityId: warehouse.id,
                note: `Received into warehouse (${warehouse.code})`,
              },
            ]),
          });

          return { replay: false, boxUids };
        },
        { maxWait: 15000, timeout: 120000 }
      );

      if (result.replay) {
        const replay = await generationReplayResponse(order, idempotencyKey);
        if (replay) return res.json(replay);
      }

      return res.json({
        message: "Boxes generated",
        orderNumber: order.orderNumber,
        donorName: donorName || order.donorName || null,
        createdCount: result.boxUids.length,
        sample: result.boxUids.slice(0, 10),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * GET /api/orders/:orderId/boxes
 */
router.get("/:orderId/boxes", requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        boxes: {
          include: { product: true, currentFacility: true },
          orderBy: { boxUid: "asc" }, // easier to print in numeric order
        },
      },
    });

    if (!order) return res.status(404).json({ message: "Order not found" });
    return res.json(order);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

/**
 * GET /api/orders/:orderId/print/a3
 * A3 landscape, 80-up (8x10)
 * ✅ Label cell: 50.9mm × 28.4mm
 * ✅ QR: 19.9mm × 19.9mm
 */
router.get(
  "/:orderId/print/a3",
  requireAuth,
  requireRole("SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      // ?goodsReceiptId=... prints only the labels of one delivery (GRN);
      // ?generationRequestId=... only one QR generation run.
      const goodsReceiptId = req.query.goodsReceiptId ? String(req.query.goodsReceiptId) : null;
      const generationRequestId = req.query.generationRequestId ? String(req.query.generationRequestId) : null;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          boxes: {
            where: goodsReceiptId ? { goodsReceiptId } : generationRequestId ? { generationRequestId } : undefined,
            include: { product: true, donor: { select: { name: true } } },
            orderBy: { boxUid: "asc" },
          },
        },
      });

      if (!order) return res.status(404).json({ message: "Order not found" });
      if (req.user.role === "COUNTRY_ADMIN" && order.boxes.some((b) => b.product?.implementationId !== req.user.implementationId)) {
        return res.status(404).json({ message: "Order not found" });
      }
      const boxes = sortBoxes(order.boxes.map((b) => ({ ...b, order })));
      await writeA3Labels(res, boxes, `${order.orderNumber}.pdf`, req.query.format);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

module.exports = router;
