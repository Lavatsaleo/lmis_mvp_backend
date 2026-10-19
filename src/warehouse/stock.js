// Helpers shared by holds, write-offs and stock counts.

const crypto = require("crypto");

const prisma = require("../lib/prisma");

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message, ...err.extra });
  console.error(err);
  return res.status(500).json({ message: "Server error", error: String(err.message || err) });
}

/** ADJ-20261018-3F9A1C style reference. */
function reference(prefix, at = new Date()) {
  const ymd = `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, "0")}${String(at.getUTCDate()).padStart(2, "0")}`;
  return `${prefix}-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/** product|batch|yyyy-mm-dd|donor: one pallet group. */
function groupKey(productId, batchNo, expiryDate, donorId) {
  return [productId, batchNo, new Date(expiryDate).toISOString().slice(0, 10), donorId || "none"].join("|");
}

const collator = new Intl.Collator("en", { numeric: true });

/**
 * Resolve which boxes in a warehouse a request means. Any combination of:
 *  - boxUids: ["PO-1-12", ...]               exact boxes (scanned/typed)
 *  - batches: [{ productId, batchNo, expiryDate, donorId?, boxes }]
 *             take N boxes of that group (highest box numbers first)
 *  - expiredOnly: true                       every expired box
 * Only IN_WAREHOUSE boxes at the warehouse count. `allowHeld` controls whether
 * boxes already on hold may be picked (never ones held by another write-off).
 */
async function resolveWarehouseBoxes({ warehouseId, boxUids = [], batches = [], expiredOnly = false, allowHeld = true, forAdjustmentId = null }) {
  const picked = new Map();
  const base = { status: "IN_WAREHOUSE", currentFacilityId: warehouseId };
  const holdOk = (b) => {
    if (b.holdAdjustmentId && b.holdAdjustmentId !== forAdjustmentId) return false;
    if (!allowHeld && b.heldAt) return false;
    return true;
  };
  const select = {
    id: true,
    boxUid: true,
    productId: true,
    batchNo: true,
    expiryDate: true,
    donorId: true,
    sachetsRemaining: true,
    sachetsPerBox: true,
    heldAt: true,
    holdAdjustmentId: true,
  };

  const uids = [...new Set((boxUids || []).map((u) => String(u).trim()).filter(Boolean))];
  if (uids.length) {
    const found = await prisma.box.findMany({ where: { boxUid: { in: uids } }, select: { ...select, status: true, currentFacilityId: true } });
    const byUid = new Map(found.map((b) => [b.boxUid, b]));
    const problems = [];
    for (const uid of uids) {
      const b = byUid.get(uid);
      if (!b) problems.push(`${uid}: not found`);
      else if (b.status !== "IN_WAREHOUSE" || b.currentFacilityId !== warehouseId) problems.push(`${uid}: not in stock at this warehouse (${b.status.toLowerCase().replace("_", " ")})`);
      else if (!holdOk(b)) problems.push(`${uid}: already part of another write-off request`);
      else picked.set(b.id, b);
    }
    if (problems.length) throw new HttpError(400, `Some boxes cannot be used: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? "…" : ""}`, { problems });
  }

  for (const [i, sel] of (batches || []).entries()) {
    const want = Number(sel.boxes);
    if (!Number.isInteger(want) || want <= 0) throw new HttpError(400, `Batch row ${i + 1}: number of boxes must be a whole number above zero`);
    const exp = new Date(sel.expiryDate);
    if (!sel.productId || !sel.batchNo || Number.isNaN(exp.getTime())) throw new HttpError(400, `Batch row ${i + 1}: product, batch and expiry are required`);
    const day = exp.toISOString().slice(0, 10);
    const candidates = (
      await prisma.box.findMany({
        where: {
          ...base,
          productId: String(sel.productId),
          batchNo: String(sel.batchNo),
          expiryDate: { gte: new Date(`${day}T00:00:00.000Z`), lt: new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86400000) },
          donorId: sel.donorId ? String(sel.donorId) : null,
        },
        select,
      })
    )
      .filter((b) => holdOk(b) && !picked.has(b.id))
      .sort((a, b) => collator.compare(b.boxUid, a.boxUid));
    if (candidates.length < want) {
      throw new HttpError(400, `Batch ${sel.batchNo}: only ${candidates.length} box${candidates.length === 1 ? "" : "es"} available, ${want} requested`);
    }
    candidates.slice(0, want).forEach((b) => picked.set(b.id, b));
  }

  if (expiredOnly) {
    const expired = await prisma.box.findMany({ where: { ...base, expiryDate: { lte: new Date() } }, select });
    expired.filter(holdOk).forEach((b) => picked.set(b.id, b));
  }

  return [...picked.values()];
}

// ---------------------------------------------------------------------------
// Evidence uploads (raw body): PDF / JPEG / PNG, checked by magic bytes.
// ---------------------------------------------------------------------------
const DOC_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const MAX_DOC_BYTES = 15 * 1024 * 1024;

function readUpload(req) {
  const mimeType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!DOC_TYPES.has(mimeType)) throw new HttpError(415, "Attach a PDF, JPEG or PNG file");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, "The file is empty");
  const head = req.body.subarray(0, 8);
  const ok =
    (mimeType === "application/pdf" && head.subarray(0, 5).toString("latin1") === "%PDF-") ||
    (mimeType === "image/jpeg" && head[0] === 0xff && head[1] === 0xd8) ||
    (mimeType === "image/png" && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  if (!ok) throw new HttpError(415, "The file content does not match its type");
  let fileName = String(req.headers["x-file-name"] || "document");
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // keep raw
  }
  fileName = fileName.replace(/[\\/\r\n"]/g, "_").slice(0, 180) || "document";
  return { mimeType, fileName, data: req.body };
}

function sendDocument(req, res, doc) {
  res.setHeader("Content-Type", doc.mimeType);
  res.setHeader("Content-Length", String(doc.sizeBytes));
  res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.end(Buffer.from(doc.data));
}

module.exports = {
  HttpError,
  sendError,
  reference,
  groupKey,
  resolveWarehouseBoxes,
  DOC_TYPES,
  MAX_DOC_BYTES,
  readUpload,
  sendDocument,
};
