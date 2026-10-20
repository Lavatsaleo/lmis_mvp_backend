// Purchase orders and goods receiving.
//
// A PO is raised in the procurement system; once final, a warehouse officer
// enters it here (header + lines, each line with its donor and price) and
// attaches the signed PDF as evidence. When goods arrive the warehouse
// records a goods receipt (GRN) against the PO lines with the batch numbers
// and expiry dates on the cartons; Anchor creates one box (QR label) per
// carton, tagged with its PO line, donor and receipt.
//
//   GET    /api/purchase-orders                    list (status, warehouseId, q, implementationId)
//   POST   /api/purchase-orders                    create
//   GET    /api/purchase-orders/:id                detail (lines, receipts, documents)
//   PATCH  /api/purchase-orders/:id                edit header / lines (not once fully received)
//   POST   /api/purchase-orders/:id/close          close: cancel if nothing received, else close short
//   POST   /api/purchase-orders/:id/documents      upload evidence (raw body: PDF/JPEG/PNG, X-File-Name)
//   GET    /api/purchase-orders/:id/documents/:docId
//   DELETE /api/purchase-orders/:id/documents/:docId
//   POST   /api/purchase-orders/:id/receipts       receive goods (X-Idempotency-Key)

const express = require("express");
const crypto = require("crypto");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { requireModule } = require("../middleware/modules");
const { isSuperAdmin } = require("../auth/access");
const { audit } = require("../auth/audit");
const { visibleWarehouseIds, canOperateWarehouse, OPERATOR_ROLES, labelGenerationError } = require("../warehouse/common");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

const MAX_BOXES_PER_RECEIPT = 5000;
const MAX_LINES = 200;
const DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const clean = (v) => {
  const s = v == null ? "" : String(v).trim();
  return s || null;
};

function dateOrNull(v, field) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  return d;
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, ...err.extra });
  if (err?.code === "P2002") return res.status(409).json({ message: "This purchase order number already exists in this country" });
  console.error(err);
  return res.status(500).json({ message: "Server error", error: String(err.message || err) });
}

/** Load a PO the user may see (404 otherwise). */
async function loadVisiblePo(req, id, include) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: String(id) }, include });
  if (!po) throw new HttpError(404, "Purchase order not found");
  const ids = await visibleWarehouseIds(req, prisma);
  if (ids !== null && !ids.includes(po.destinationWarehouseId)) throw new HttpError(404, "Purchase order not found");
  return po;
}

async function assertCanOperate(req, warehouseId) {
  const warehouse = await prisma.facility.findUnique({ where: { id: String(warehouseId) } });
  if (!warehouse || warehouse.type !== "WAREHOUSE") throw new HttpError(400, "Destination must be a warehouse");
  if (!canOperateWarehouse(req.user, warehouse)) {
    throw new HttpError(403, "You can only record purchase orders and deliveries for your own warehouse");
  }
  return warehouse;
}

function statusFor(lines) {
  const ordered = lines.reduce((s, l) => s + l.quantityPacks, 0);
  const received = lines.reduce((s, l) => s + l.receivedPacks, 0);
  if (received <= 0) return "OPEN";
  return received >= ordered ? "RECEIVED" : "PARTIALLY_RECEIVED";
}

// Validate submitted lines against the implementation's products and donors.
async function validateLines(rawLines, implementationId, existingById = new Map()) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new HttpError(400, "Add at least one line");
  if (rawLines.length > MAX_LINES) throw new HttpError(400, `A purchase order can have at most ${MAX_LINES} lines`);

  const productIds = [...new Set(rawLines.map((l) => String(l.productId || "")))];
  const donorIds = [...new Set(rawLines.map((l) => String(l.donorId || "")))];
  const [products, donors] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: productIds } } }),
    prisma.donor.findMany({ where: { id: { in: donorIds } } }),
  ]);
  const productMap = new Map(products.map((p) => [p.id, p]));
  const donorMap = new Map(donors.map((d) => [d.id, d]));

  return rawLines.map((l, i) => {
    const where = `Line ${i + 1}`;
    const product = productMap.get(String(l.productId || ""));
    if (!product) throw new HttpError(400, `${where}: choose a product`);
    if (product.implementationId && product.implementationId !== implementationId) {
      throw new HttpError(400, `${where}: ${product.name} belongs to another country`);
    }
    const donor = donorMap.get(String(l.donorId || ""));
    if (!donor) throw new HttpError(400, `${where}: choose a donor`);
    if (donor.implementationId !== implementationId) throw new HttpError(400, `${where}: donor belongs to another country`);
    const quantityPacks = Number(l.quantityPacks);
    if (!Number.isInteger(quantityPacks) || quantityPacks <= 0) {
      throw new HttpError(400, `${where}: quantity must be a whole number of ${product.packUnitName || "packs"} above zero`);
    }
    const unitPrice = Number(l.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new HttpError(400, `${where}: unit price must be zero or more`);

    const existing = l.id ? existingById.get(String(l.id)) : null;
    if (l.id && !existing) throw new HttpError(400, `${where}: line not found on this purchase order`);
    if (existing && existing.receivedPacks > 0) {
      if (existing.productId !== product.id || existing.donorId !== donor.id) {
        throw new HttpError(400, `${where}: product and donor cannot change after goods were received on this line`);
      }
      if (quantityPacks < existing.receivedPacks) {
        throw new HttpError(400, `${where}: quantity cannot be below the ${existing.receivedPacks} already received`);
      }
    }
    return {
      id: existing?.id || null,
      productId: product.id,
      donorId: donor.id,
      grantCode: clean(l.grantCode),
      quantityPacks,
      unitPrice,
    };
  });
}

const DETAIL_INCLUDE = {
  destinationWarehouse: { select: { id: true, code: true, name: true, stockLocationType: true, implementationId: true } },
  createdBy: { select: { id: true, fullName: true } },
  implementation: { select: { id: true, name: true, country: { select: { name: true, code: true } } } },
  lines: {
    orderBy: { lineNo: "asc" },
    include: {
      product: { select: { id: true, code: true, name: true, packUnitName: true, baseUnitName: true, unitsPerPack: true } },
      donor: { select: { id: true, name: true, code: true } },
    },
  },
  documents: {
    orderBy: { createdAt: "asc" },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { fullName: true } } },
  },
  receipts: {
    orderBy: { receivedAt: "desc" },
    include: {
      receivedBy: { select: { id: true, fullName: true } },
      lines: { include: { purchaseOrderLine: { select: { lineNo: true, product: { select: { name: true } } } } } },
      _count: { select: { boxes: true } },
    },
  },
  order: { select: { id: true, orderNumber: true } },
};

function serializePo(po) {
  const lines = (po.lines || []).map((l) => {
    const unitPrice = Number(l.unitPrice);
    return {
      ...l,
      unitPrice,
      lineValue: Number((unitPrice * l.quantityPacks).toFixed(2)),
      receivedValue: Number((unitPrice * l.receivedPacks).toFixed(2)),
      outstandingPacks: Math.max(0, l.quantityPacks - l.receivedPacks),
    };
  });
  const orderedPacks = lines.reduce((s, l) => s + l.quantityPacks, 0);
  const receivedPacks = lines.reduce((s, l) => s + l.receivedPacks, 0);
  const now = Date.now();
  return {
    ...po,
    lines,
    totals: {
      orderedPacks,
      receivedPacks,
      outstandingPacks: Math.max(0, orderedPacks - receivedPacks),
      value: Number(lines.reduce((s, l) => s + l.lineValue, 0).toFixed(2)),
      receivedValue: Number(lines.reduce((s, l) => s + l.receivedValue, 0).toFixed(2)),
      percentReceived: orderedPacks ? Math.round((receivedPacks / orderedPacks) * 100) : 0,
    },
    donors: [...new Map(lines.map((l) => [l.donor?.id, l.donor])).values()].filter(Boolean),
    isOverdue:
      ["OPEN", "PARTIALLY_RECEIVED"].includes(po.status) && po.expectedDeliveryDate && po.expectedDeliveryDate.getTime() < now,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const ids = await visibleWarehouseIds(req, prisma);
    if (ids !== null && !ids.length) return res.json({ rows: [], total: 0 });

    const where = {};
    if (ids !== null) where.destinationWarehouseId = { in: ids };
    if (isSuperAdmin(req.user) && req.query.implementationId) where.implementationId = String(req.query.implementationId);
    if (req.query.warehouseId) {
      const wh = String(req.query.warehouseId);
      if (ids !== null && !ids.includes(wh)) return res.json({ rows: [], total: 0 });
      where.destinationWarehouseId = wh;
    }
    const status = String(req.query.status || "").toUpperCase();
    if (status === "OPEN_ANY") where.status = { in: ["OPEN", "PARTIALLY_RECEIVED"] };
    else if (status) where.status = status;
    if (req.query.q) {
      const q = String(req.query.q).trim();
      where.OR = [{ poNumber: { contains: q } }, { supplierName: { contains: q } }, { lines: { some: { donor: { name: { contains: q } } } } }];
    }
    if (req.query.donorId) where.lines = { some: { donorId: String(req.query.donorId) } };

    const take = Math.min(200, Math.max(1, Number.parseInt(req.query.take || "50", 10) || 50));
    const skip = Math.max(0, Number.parseInt(req.query.skip || "0", 10) || 0);
    const [total, rows] = await Promise.all([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        take,
        skip,
        include: {
          destinationWarehouse: { select: { id: true, code: true, name: true } },
          lines: { include: { donor: { select: { id: true, name: true } }, product: { select: { id: true, name: true, packUnitName: true } } } },
          _count: { select: { documents: true, receipts: true } },
        },
      }),
    ]);
    return res.json({ total, rows: rows.map(serializePo) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post("/", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const poNumber = clean(body.poNumber);
    if (!poNumber) throw new HttpError(400, "PO number is required");
    if (poNumber.length > 100) throw new HttpError(400, "PO number is too long");

    const warehouse = await assertCanOperate(req, body.destinationWarehouseId || req.user.warehouseId);
    const implementationId = warehouse.implementationId;
    if (!implementationId) throw new HttpError(400, "This warehouse is not linked to a country");

    const lines = await validateLines(body.lines, implementationId);
    const currencyCode = (clean(body.currencyCode) || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new HttpError(400, "Currency must be a 3-letter code, e.g. USD");

    const po = await prisma.purchaseOrder.create({
      data: {
        implementationId,
        poNumber,
        supplierName: clean(body.supplierName),
        destinationWarehouseId: warehouse.id,
        orderDate: dateOrNull(body.orderDate, "Order date"),
        expectedDeliveryDate: dateOrNull(body.expectedDeliveryDate, "Expected delivery date"),
        currencyCode,
        note: clean(body.note),
        createdById: req.user.id,
        lines: { create: lines.map(({ id, ...l }, i) => ({ ...l, lineNo: i + 1 })) },
      },
      include: DETAIL_INCLUDE,
    });
    await audit(req, {
      action: "PO_CREATED",
      targetType: "PURCHASE_ORDER",
      target: { id: po.id, name: po.poNumber },
      implementationId,
      details: { warehouse: warehouse.code, lines: lines.length, currencyCode },
    });
    return res.status(201).json(serializePo(po));
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const po = await loadVisiblePo(req, req.params.id, DETAIL_INCLUDE);
    const warehouse = await prisma.facility.findUnique({ where: { id: po.destinationWarehouseId } });
    return res.json({ ...serializePo(po), canOperate: canOperateWarehouse(req.user, warehouse) });
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------
router.patch("/:id", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const po = await loadVisiblePo(req, req.params.id, { lines: true });
    await assertCanOperate(req, po.destinationWarehouseId);
    if (po.status === "CANCELLED" || po.status === "RECEIVED") {
      throw new HttpError(400, `This purchase order is ${po.status.toLowerCase()} and can no longer be edited`);
    }
    const body = req.body || {};
    const data = {};
    if (body.poNumber !== undefined) {
      const n = clean(body.poNumber);
      if (!n) throw new HttpError(400, "PO number is required");
      if (n !== po.poNumber && po.lines.some((l) => l.receivedPacks > 0)) {
        throw new HttpError(400, "The PO number cannot change after goods were received (box labels use it)");
      }
      data.poNumber = n;
    }
    if (body.supplierName !== undefined) data.supplierName = clean(body.supplierName);
    if (body.orderDate !== undefined) data.orderDate = dateOrNull(body.orderDate, "Order date");
    if (body.expectedDeliveryDate !== undefined) data.expectedDeliveryDate = dateOrNull(body.expectedDeliveryDate, "Expected delivery date");
    if (body.note !== undefined) data.note = clean(body.note);
    if (body.currencyCode !== undefined) {
      const c = (clean(body.currencyCode) || "").toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) throw new HttpError(400, "Currency must be a 3-letter code, e.g. USD");
      if (c !== po.currencyCode && po.lines.some((l) => l.receivedPacks > 0)) {
        throw new HttpError(400, "The currency cannot change after goods were received");
      }
      data.currencyCode = c;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (body.lines !== undefined) {
        const existingById = new Map(po.lines.map((l) => [l.id, l]));
        const lines = await validateLines(body.lines, po.implementationId, existingById);
        const keep = new Set(lines.filter((l) => l.id).map((l) => l.id));
        const removed = po.lines.filter((l) => !keep.has(l.id));
        const blocked = removed.find((l) => l.receivedPacks > 0);
        if (blocked) throw new HttpError(400, `Line ${blocked.lineNo} has received goods and cannot be removed`);
        if (removed.length) await tx.purchaseOrderLine.deleteMany({ where: { id: { in: removed.map((l) => l.id) } } });

        // Keep line numbers stable for existing lines; append new ones.
        let nextNo = Math.max(0, ...po.lines.map((l) => l.lineNo)) + 1;
        for (const l of lines) {
          const { id, ...fields } = l;
          if (id) await tx.purchaseOrderLine.update({ where: { id }, data: fields });
          else await tx.purchaseOrderLine.create({ data: { ...fields, purchaseOrderId: po.id, lineNo: nextNo++ } });
        }
        const fresh = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        data.status = statusFor(fresh);
      }
      return tx.purchaseOrder.update({ where: { id: po.id }, data, include: DETAIL_INCLUDE });
    });

    await audit(req, {
      action: "PO_UPDATED",
      targetType: "PURCHASE_ORDER",
      target: { id: po.id, name: updated.poNumber },
      implementationId: po.implementationId,
      details: { fields: Object.keys(data).filter((k) => k !== "status"), linesChanged: body.lines !== undefined },
    });
    return res.json(serializePo(updated));
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Close: nothing received -> CANCELLED; partly received -> RECEIVED (short).
// ---------------------------------------------------------------------------
router.post("/:id/close", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const po = await loadVisiblePo(req, req.params.id, { lines: true });
    await assertCanOperate(req, po.destinationWarehouseId);
    if (po.status === "CANCELLED" || po.status === "RECEIVED") throw new HttpError(400, "This purchase order is already closed");
    const reason = clean(req.body?.reason);
    if (!reason) throw new HttpError(400, "Give a reason for closing the purchase order");
    const anyReceived = po.lines.some((l) => l.receivedPacks > 0);
    const updated = await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { status: anyReceived ? "RECEIVED" : "CANCELLED", cancelledAt: new Date(), cancelReason: reason },
      include: DETAIL_INCLUDE,
    });
    await audit(req, {
      action: anyReceived ? "PO_CLOSED_SHORT" : "PO_CANCELLED",
      targetType: "PURCHASE_ORDER",
      target: { id: po.id, name: po.poNumber },
      implementationId: po.implementationId,
      details: { reason },
    });
    return res.json(serializePo(updated));
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Documents (evidence). Body is the raw file; name in X-File-Name.
// ---------------------------------------------------------------------------
router.post(
  "/:id/documents",
  requireRole(...OPERATOR_ROLES),
  express.raw({ type: [...DOC_TYPES], limit: MAX_DOC_BYTES }),
  async (req, res) => {
    try {
      const po = await loadVisiblePo(req, req.params.id);
      await assertCanOperate(req, po.destinationWarehouseId);
      const mimeType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (!DOC_TYPES.has(mimeType)) throw new HttpError(415, "Attach a PDF, JPEG or PNG file");
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "The file is empty");
      // Check the file really is what it claims (magic bytes).
      const head = req.body.subarray(0, 8);
      const looksRight =
        (mimeType === "application/pdf" && head.subarray(0, 5).toString("latin1") === "%PDF-") ||
        (mimeType === "image/jpeg" && head[0] === 0xff && head[1] === 0xd8) ||
        (mimeType === "image/png" && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
      if (!looksRight) throw new HttpError(415, "The file content does not match its type");

      let fileName = "document";
      try {
        fileName = decodeURIComponent(String(req.headers["x-file-name"] || "document"));
      } catch {
        fileName = String(req.headers["x-file-name"] || "document");
      }
      fileName = fileName.replace(/[\\/\r\n"]/g, "_").slice(0, 180) || "document";

      const doc = await prisma.purchaseOrderDocument.create({
        data: { purchaseOrderId: po.id, fileName, mimeType, sizeBytes: req.body.length, data: req.body, uploadedById: req.user.id },
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
      });
      await audit(req, {
        action: "PO_DOCUMENT_ADDED",
        targetType: "PURCHASE_ORDER",
        target: { id: po.id, name: po.poNumber },
        implementationId: po.implementationId,
        details: { fileName, sizeBytes: req.body.length },
      });
      return res.status(201).json(doc);
    } catch (err) {
      if (err?.type === "entity.too.large") return res.status(413).json({ message: "File is larger than 15 MB" });
      return sendError(res, err);
    }
  }
);

router.get("/:id/documents/:docId", async (req, res) => {
  try {
    const po = await loadVisiblePo(req, req.params.id);
    const doc = await prisma.purchaseOrderDocument.findFirst({ where: { id: String(req.params.docId), purchaseOrderId: po.id } });
    if (!doc) throw new HttpError(404, "Document not found");
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Length", String(doc.sizeBytes));
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.end(Buffer.from(doc.data));
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete("/:id/documents/:docId", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const po = await loadVisiblePo(req, req.params.id);
    await assertCanOperate(req, po.destinationWarehouseId);
    const doc = await prisma.purchaseOrderDocument.findFirst({
      where: { id: String(req.params.docId), purchaseOrderId: po.id },
      select: { id: true, fileName: true },
    });
    if (!doc) throw new HttpError(404, "Document not found");
    await prisma.purchaseOrderDocument.delete({ where: { id: doc.id } });
    await audit(req, {
      action: "PO_DOCUMENT_REMOVED",
      targetType: "PURCHASE_ORDER",
      target: { id: po.id, name: po.poNumber },
      implementationId: po.implementationId,
      details: { fileName: doc.fileName },
    });
    return res.status(204).end();
  } catch (err) {
    return sendError(res, err);
  }
});

// ---------------------------------------------------------------------------
// Receive goods against the PO.
// Body: { receivedAt?, deliveryNote?, waybillNo?, note?,
//         lines: [{ lineId, batchNo, expiryDate, packs }] }   (a PO line can
//         appear several times when it arrives as several batches)
// Header X-Idempotency-Key: a retry returns the receipt already recorded.
// ---------------------------------------------------------------------------
function grnNumber(at = new Date()) {
  const d = at;
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `GRN-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
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

async function receiptResponse(receiptId) {
  const receipt = await prisma.goodsReceipt.findUnique({
    where: { id: receiptId },
    include: {
      lines: { include: { purchaseOrderLine: { select: { lineNo: true, product: { select: { name: true } } } } } },
      boxes: { select: { boxUid: true }, orderBy: { createdAt: "asc" }, take: 10 },
      _count: { select: { boxes: true } },
      purchaseOrder: { select: { id: true, poNumber: true, status: true, order: { select: { id: true, orderNumber: true } } } },
    },
  });
  return {
    receipt,
    grnNumber: receipt.grnNumber,
    createdCount: receipt._count.boxes,
    sample: receipt.boxes.map((b) => b.boxUid),
    orderId: receipt.purchaseOrder.order?.id || null,
    purchaseOrderStatus: receipt.purchaseOrder.status,
  };
}

router.post("/:id/receipts", requireRole(...OPERATOR_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const idemRaw = req.header("X-Idempotency-Key") || req.header("X-Queue-Id");
    const clientRequestId = idemRaw && String(idemRaw).trim().length <= 191 ? String(idemRaw).trim() : null;
    if (clientRequestId) {
      const prior = await prisma.goodsReceipt.findUnique({ where: { clientRequestId }, select: { id: true } });
      if (prior) return res.json({ ...(await receiptResponse(prior.id)), replayed: true });
    }

    const po = await loadVisiblePo(req, req.params.id, { lines: { include: { product: true } } });
    const warehouse = await assertCanOperate(req, po.destinationWarehouseId);
    const labelPolicy = await labelGenerationError(warehouse);
    if (labelPolicy) throw new HttpError(403, labelPolicy, { code: "LABELS_MAIN_WAREHOUSE_ONLY" });
    if (!["OPEN", "PARTIALLY_RECEIVED"].includes(po.status)) {
      throw new HttpError(400, `This purchase order is ${po.status.toLowerCase().replace("_", " ")}; it cannot receive goods`);
    }

    // ---- Validate every receipt line before writing anything
    if (!Array.isArray(body.lines) || !body.lines.length) throw new HttpError(400, "Enter at least one line received");
    const lineMap = new Map(po.lines.map((l) => [l.id, l]));
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const parsed = body.lines.map((r, i) => {
      const where = `Row ${i + 1}`;
      const line = lineMap.get(String(r.lineId || ""));
      if (!line) throw new HttpError(400, `${where}: choose a PO line`);
      const batchNo = clean(r.batchNo);
      if (!batchNo) throw new HttpError(400, `${where}: batch number is required`);
      if (batchNo.length > 100) throw new HttpError(400, `${where}: batch number is too long`);
      const expiry = dateOrNull(r.expiryDate, `${where}: expiry date`);
      if (!expiry) throw new HttpError(400, `${where}: expiry date is required`);
      if (expiry < today) throw new HttpError(400, `${where}: batch ${batchNo} is already expired; do not receive expired goods`);
      const packs = Number(r.packs);
      if (!Number.isInteger(packs) || packs <= 0) throw new HttpError(400, `${where}: quantity must be a whole number above zero`);
      return { line, batchNo, expiry, packs };
    });

    const byLine = new Map();
    for (const p of parsed) byLine.set(p.line.id, (byLine.get(p.line.id) || 0) + p.packs);
    for (const [lineId, packs] of byLine) {
      const line = lineMap.get(lineId);
      const outstanding = line.quantityPacks - line.receivedPacks;
      if (packs > outstanding) {
        throw new HttpError(
          400,
          `Line ${line.lineNo} (${line.product.name}): receiving ${packs} but only ${outstanding} outstanding. ` +
            "If the supplier delivered more, update the purchase order first.",
          { code: "OVER_RECEIPT", lineId, outstanding }
        );
      }
    }
    const totalBoxes = parsed.reduce((s, p) => s + p.packs, 0);
    if (totalBoxes > MAX_BOXES_PER_RECEIPT) {
      throw new HttpError(400, `Receive at most ${MAX_BOXES_PER_RECEIPT} cartons per receipt; split the delivery`);
    }
    // A plain date (yyyy-mm-dd) means "that day": today -> now; an earlier day
    // -> midday UTC, so it shows on the right date in every African time zone.
    let receivedAt = dateOrNull(body.receivedAt, "Received date") || new Date();
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(body.receivedAt || ""))) {
      const todayIso = new Date().toISOString().slice(0, 10);
      receivedAt = body.receivedAt === todayIso ? new Date() : new Date(`${body.receivedAt}T12:00:00.000Z`);
    }
    if (receivedAt.getTime() > Date.now() + 5 * 60 * 1000) throw new HttpError(400, "Received date cannot be in the future");

    const receiptId = await prisma.$transaction(
      async (tx) => {
        // Serialise receipts for this PO (line totals and box numbering).
        await tx.$queryRaw`SELECT id FROM \`PurchaseOrder\` WHERE id = ${po.id} FOR UPDATE`;
        if (clientRequestId) {
          const prior = await tx.goodsReceipt.findUnique({ where: { clientRequestId }, select: { id: true } });
          if (prior) return prior.id;
        }

        // Re-check outstanding quantities under the lock.
        const freshLines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        const freshMap = new Map(freshLines.map((l) => [l.id, l]));
        for (const [lineId, packs] of byLine) {
          const l = freshMap.get(lineId);
          if (packs > l.quantityPacks - l.receivedPacks) {
            throw new HttpError(409, `Line ${l.lineNo} was just received by someone else; refresh and try again`, { code: "OVER_RECEIPT" });
          }
        }

        // One Order per PO, numbered by the PO number (the box label prefix).
        // An order with the same number entered the old way (Generate Boxes)
        // is adopted so numbering continues.
        let order = await tx.order.findUnique({ where: { purchaseOrderId: po.id } });
        if (!order) {
          const sameNumber = await tx.order.findUnique({ where: { orderNumber: po.poNumber } });
          if (sameNumber && sameNumber.purchaseOrderId) {
            throw new HttpError(409, `Box labels for ${po.poNumber} already belong to another purchase order`);
          }
          if (sameNumber) {
            // Only adopt an older order from this same country.
            const foreign = await tx.box.findFirst({
              where: { orderId: sameNumber.id, product: { implementationId: { not: po.implementationId } } },
              select: { id: true },
            });
            if (foreign) {
              throw new HttpError(409, `Box labels numbered ${po.poNumber} already exist in another country; use a distinct PO number`);
            }
          }
          order = sameNumber
            ? await tx.order.update({ where: { id: sameNumber.id }, data: { purchaseOrderId: po.id } })
            : await tx.order.create({ data: { orderNumber: po.poNumber, purchaseOrderId: po.id } });
        }

        const receipt = await tx.goodsReceipt.create({
          data: {
            grnNumber: grnNumber(receivedAt),
            purchaseOrderId: po.id,
            warehouseId: warehouse.id,
            receivedById: req.user.id,
            receivedAt,
            deliveryNote: clean(body.deliveryNote),
            waybillNo: clean(body.waybillNo),
            note: clean(body.note),
            clientRequestId,
            lines: {
              create: parsed.map((p) => ({ purchaseOrderLineId: p.line.id, batchNo: p.batchNo, expiryDate: p.expiry, packs: p.packs })),
            },
          },
        });

        const existingUids = (await tx.box.findMany({ where: { orderId: order.id }, select: { boxUid: true } })).map((b) => b.boxUid);
        let seq = nextBoxSequence(order.orderNumber, existingUids);
        const boxRows = [];
        for (const p of parsed) {
          const perBox = Math.max(1, Number(p.line.product.unitsPerPack || 1));
          for (let i = 0; i < p.packs; i += 1) {
            boxRows.push({
              boxUid: `${order.orderNumber}-${seq++}`,
              orderId: order.id,
              productId: p.line.productId,
              batchNo: p.batchNo,
              expiryDate: p.expiry,
              status: "IN_WAREHOUSE",
              currentFacilityId: warehouse.id,
              sachetsPerBox: perBox,
              sachetsRemaining: perBox,
              donorId: p.line.donorId,
              purchaseOrderLineId: p.line.id,
              goodsReceiptId: receipt.id,
              createdAt: receivedAt,
            });
          }
        }
        await tx.box.createMany({ data: boxRows });
        const created = await tx.box.findMany({ where: { goodsReceiptId: receipt.id }, select: { id: true } });
        await tx.boxEvent.createMany({
          data: created.flatMap((b) => [
            {
              boxId: b.id,
              type: "QR_CREATED",
              performedByUserId: req.user.id,
              toFacilityId: warehouse.id,
              note: `QR created for ${po.poNumber} (${receipt.grnNumber})`,
              createdAt: receivedAt,
            },
            {
              boxId: b.id,
              type: "WAREHOUSE_RECEIVE",
              performedByUserId: req.user.id,
              toFacilityId: warehouse.id,
              note: `Received against ${po.poNumber} (${receipt.grnNumber})`,
              createdAt: receivedAt,
            },
          ]),
        });

        for (const [lineId, packs] of byLine) {
          await tx.purchaseOrderLine.update({ where: { id: lineId }, data: { receivedPacks: { increment: packs } } });
        }
        const after = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } });
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: statusFor(after) } });

        // Batch valuation for Inventory Intelligence, only when none exists
        // (boxes themselves are valued from their PO line).
        for (const p of parsed) {
          const exists = await tx.productBatchValuation.findUnique({
            where: { productId_batchNo: { productId: p.line.productId, batchNo: p.batchNo } },
            select: { id: true },
          });
          if (!exists) {
            await tx.productBatchValuation.create({
              data: {
                implementationId: po.implementationId,
                productId: p.line.productId,
                batchNo: p.batchNo,
                unitValue: Number(p.line.unitPrice) / Math.max(1, Number(p.line.product.unitsPerPack || 1)),
                currencyCode: po.currencyCode,
                valuationBasis: "PURCHASE_COST",
                sourceType: "PURCHASE",
                sourceReference: po.poNumber,
              },
            });
          }
        }
        return receipt.id;
      },
      { maxWait: 15000, timeout: 120000 }
    );

    const response = await receiptResponse(receiptId);
    await audit(req, {
      action: "GOODS_RECEIVED",
      targetType: "PURCHASE_ORDER",
      target: { id: po.id, name: po.poNumber },
      implementationId: po.implementationId,
      details: { grnNumber: response.grnNumber, boxes: response.createdCount, warehouse: warehouse.code },
    });
    return res.status(201).json(response);
  } catch (err) {
    if (err?.code === "P2002" && String(err?.meta?.target || "").includes("clientRequestId")) {
      const prior = await prisma.goodsReceipt.findUnique({ where: { clientRequestId: req.header("X-Idempotency-Key") }, select: { id: true } });
      if (prior) return res.json({ ...(await receiptResponse(prior.id)), replayed: true });
    }
    return sendError(res, err);
  }
});

module.exports = router;
