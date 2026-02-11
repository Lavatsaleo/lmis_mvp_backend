const express = require("express");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const { PrismaClient } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");

const prisma = new PrismaClient();
const router = express.Router();

// ---- helpers
const mm = (v) => v * 2.834645669; // mm -> PDF points

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}

/**
 * POST /api/boxes/generate
 * Body:
 * {
 *   "orderNumber": "SPO-ISL-00884-001",
 *   "productCode": "A0200192",
 *   "productName": "Enov’Nutributter+®",
 *   "batchNo": "25183001",
 *   "expiryDate": "2027-04-30",
 *   "quantity": 1146
 * }
 */
router.post(
  "/generate",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const {
        orderNumber,
        productCode,
        productName,
        batchNo,
        expiryDate,
        quantity,
      } = req.body;

      if (!orderNumber || !productCode || !batchNo || !expiryDate || !quantity) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: "quantity must be a positive integer" });
      }

      const exp = new Date(expiryDate);
      if (isNaN(exp.getTime())) {
        return res.status(400).json({ message: "expiryDate must be a valid date (YYYY-MM-DD)" });
      }

      // upsert Order
      const order = await prisma.order.upsert({
        where: { orderNumber },
        update: {},
        create: { orderNumber },
      });

      // upsert Product
      const product = await prisma.product.upsert({
        where: { code: productCode },
        update: { name: productName || undefined },
        create: { code: productCode, name: productName || productCode },
      });

      // determine next sequence for this order (simple MVP approach)
      const existingCount = await prisma.box.count({ where: { orderId: order.id } });
      const startSeq = existingCount + 1;

      const createdAtFloor = new Date(); // mark time just before creating

      const data = Array.from({ length: qty }).map((_, i) => {
        const seq = String(startSeq + i).padStart(5, "0");
        const boxUid = `${orderNumber}-${seq}`;
        return {
          boxUid,
          orderId: order.id,
          productId: product.id,
          batchNo,
          expiryDate: exp,
          status: "CREATED",
        };
      });

      // Create boxes in bulk
      await prisma.box.createMany({ data, skipDuplicates: true });

      // Fetch the boxes we just created (for events + response)
      const boxes = await prisma.box.findMany({
        where: {
          orderId: order.id,
          batchNo,
          expiryDate: exp,
          createdAt: { gte: createdAtFloor },
        },
        orderBy: { boxUid: "asc" },
      });

      // Create QR_CREATED events
      if (boxes.length > 0) {
        await prisma.boxEvent.createMany({
          data: boxes.map((b) => ({
            boxId: b.id,
            type: "QR_CREATED",
            performedByUserId: req.user.id,
            note: `QR generated for ${b.boxUid}`,
          })),
        });
      }

      return res.json({
        message: "Boxes generated",
        orderNumber,
        productCode,
        batchNo,
        expiryDate,
        requested: qty,
        created: boxes.length,
        sample: boxes.slice(0, 5).map((b) => b.boxUid),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * GET /api/boxes/print/a3?orderNumber=SPO-ISL-00884-001
 * Optional: &batchNo=25183001
 * Returns an A3 landscape PDF with 80 labels per page (8 x 10)
 */
router.get(
  "/print/a3",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderNumber, batchNo } = req.query;
      if (!orderNumber) return res.status(400).json({ message: "orderNumber is required" });

      const order = await prisma.order.findUnique({ where: { orderNumber: String(orderNumber) } });
      if (!order) return res.status(404).json({ message: "Order not found" });

      const where = { orderId: order.id };
      if (batchNo) where.batchNo = String(batchNo);

      const boxes = await prisma.box.findMany({
        where,
        include: { product: true },
        orderBy: { boxUid: "asc" },
      });

      if (boxes.length === 0) return res.status(404).json({ message: "No boxes found to print" });

      // PDF setup: A3 landscape
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${orderNumber}_A3_80up.pdf"`);

      const doc = new PDFDocument({ size: "A3", layout: "landscape", margin: mm(6) });
      doc.pipe(res);

      const cols = 8;
      const rows = 10;
      const margin = mm(6);

      const pageW = doc.page.width;
      const pageH = doc.page.height;

      const cellW = (pageW - margin * 2) / cols;
      const cellH = (pageH - margin * 2) / rows;

      const padding = mm(2);
      const qrSize = Math.min(cellW - padding * 2, cellH - padding * 2 - mm(8));

      let i = 0;

      for (const b of boxes) {
        const idxOnPage = i % (cols * rows);
        if (i > 0 && idxOnPage === 0) doc.addPage();

        const r = Math.floor(idxOnPage / cols);
        const c = idxOnPage % cols;

        const x = margin + c * cellW;
        const y = margin + r * cellH;

        const dataUrl = await QRCode.toDataURL(b.boxUid, { margin: 0, scale: 6 });
        const base64 = dataUrl.split(",")[1];
        const img = Buffer.from(base64, "base64");

        doc.image(img, x + padding, y + padding, { width: qrSize, height: qrSize });

        doc
          .fontSize(7)
          .text(`${b.boxUid}`, x + padding, y + padding + qrSize + mm(1), {
            width: cellW - padding * 2,
          });

        doc
          .fontSize(6)
          .text(
            `Batch: ${b.batchNo} | Exp: ${b.expiryDate.toISOString().slice(0, 10)}`,
            x + padding,
            y + padding + qrSize + mm(5),
            { width: cellW - padding * 2 }
          );

        i++;
      }

      doc.end();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

module.exports = router;
