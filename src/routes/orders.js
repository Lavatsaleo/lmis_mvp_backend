const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const PDFDocument = require("pdfkit");

// ✅ QR helpers
const { buildBoxPayload, payloadToPngBuffer } = require("../utils/qr");

// ✅ Auth + RBAC
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

/**
 * POST /api/orders
 * Body: { orderNumber, donorName? }
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 */
router.post(
  "/",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
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
 * Body: { productCode, productName, batchNo, expiryDate, quantity, warehouseFacilityId, donorName? }
 * Roles: SUPER_ADMIN, WAREHOUSE_OFFICER
 *
 * Box UID format:
 *   <ORDER_NUMBER>-<SEQUENCE>
 * Like below
 *   SPO-ISL-00884-001-1
 *   SPO-ISL-00884-001-2
 */
router.post(
  "/:orderId/boxes/generate",
  requireAuth,
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const { productCode, productName, batchNo, expiryDate, quantity, warehouseFacilityId, donorName } = req.body || {};

      if (!productCode || !productName || !batchNo || !expiryDate || !quantity || !warehouseFacilityId) {
        return res.status(400).json({
          message: "productCode, productName, batchNo, expiryDate, quantity, warehouseFacilityId are required",
        });
      }

      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ message: "quantity must be a positive integer" });
      }

      const exp = new Date(expiryDate);
      if (isNaN(exp.getTime())) {
        return res.status(400).json({ message: "expiryDate must be a valid date (YYYY-MM-DD)" });
      }

      const [order, warehouse] = await Promise.all([
        prisma.order.findUnique({ where: { id: orderId } }),
        prisma.facility.findUnique({ where: { id: warehouseFacilityId } }),
      ]);

      if (!order) return res.status(404).json({ message: "Order not found" });
      if (!warehouse) return res.status(404).json({ message: "Warehouse facility not found" });

      // set donorName on order if provided
      if (donorName) {
        if (order.donorName && order.donorName !== donorName) {
          return res.status(400).json({
            message: `Order already has donorName="${order.donorName}". You sent "${donorName}".`,
          });
        }
        if (!order.donorName) {
          await prisma.order.update({ where: { id: order.id }, data: { donorName } });
        }
      }

      const product = await prisma.product.upsert({
        where: { code: productCode },
        update: { name: productName },
        create: { code: productCode, name: productName },
      });

      const createdBoxUids = [];

      await prisma.$transaction(async (tx) => {
        const existingCount = await tx.box.count({ where: { orderId: order.id } });
        const startSeq = existingCount + 1;

        for (let i = 0; i < qty; i++) {
          const seq = startSeq + i;
          const boxUid = `${order.orderNumber}-${seq}`;

          const box = await tx.box.create({
            data: {
              boxUid,
              orderId: order.id,
              productId: product.id,
              batchNo,
              expiryDate: exp,
              status: "IN_WAREHOUSE",
              currentFacilityId: warehouse.id,
            },
          });

          await tx.boxEvent.createMany({
            data: [
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
            ],
          });

          createdBoxUids.push(boxUid);
        }
      });

      return res.json({
        message: "Boxes generated",
        orderNumber: order.orderNumber,
        donorName: donorName || order.donorName || null,
        createdCount: createdBoxUids.length,
        sample: createdBoxUids.slice(0, 10),
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
  requireRole("SUPER_ADMIN", "WAREHOUSE_OFFICER"),
  async (req, res) => {
    try {
      const { orderId } = req.params;

      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: { boxes: { include: { product: true }, orderBy: { boxUid: "asc" } } },
      });

      if (!order) return res.status(404).json({ message: "Order not found" });

      // FIXED PRINT SPECS 
      const PAGE_W_MM = 420; // A3 landscape width
      const PAGE_H_MM = 297; // A3 landscape height
      const COLS = 8;
      const ROWS = 10;

      const LABEL_W_MM = 50.9;
      const LABEL_H_MM = 28.4;
      const QR_MM = 19.9;

      // Center the whole grid on the page
      const gridWmm = LABEL_W_MM * COLS;
      const gridHmm = LABEL_H_MM * ROWS;

      const marginXmm = (PAGE_W_MM - gridWmm) / 2; // ~6.4mm
      const marginYmm = (PAGE_H_MM - gridHmm) / 2; // ~6.5mm

      const pageW = mmToPt(PAGE_W_MM);
      const pageH = mmToPt(PAGE_H_MM);

      const marginX = mmToPt(marginXmm);
      const marginY = mmToPt(marginYmm);

      const cellW = mmToPt(LABEL_W_MM);
      const cellH = mmToPt(LABEL_H_MM);

      const qrSize = mmToPt(QR_MM);

      // Padding / spacing inside a cell
      const leftPad = mmToPt(2.0);
      const rightPad = mmToPt(1.8);
      const gap = mmToPt(2.0);

      res.setHeader("Content-Type", "application/pdf");
      // easier to download
      res.setHeader("Content-Disposition", `attachment; filename="${order.orderNumber}_A3_80up.pdf"`);

      const doc = new PDFDocument({
        size: [pageW, pageH],
        margins: { top: 0, left: 0, right: 0, bottom: 0 },
      });

      doc.pipe(res);

      for (let i = 0; i < order.boxes.length; i++) {
        const box = order.boxes[i];

        // new page every 80
        if (i > 0 && i % (COLS * ROWS) === 0) doc.addPage();

        const indexOnPage = i % (COLS * ROWS);
        const r = Math.floor(indexOnPage / COLS);
        const c = indexOnPage % COLS;

        const x = marginX + c * cellW;
        const y = marginY + r * cellH;

        // optional light border
        doc.save().lineWidth(0.4).strokeColor("#E0E0E0").rect(x, y, cellW, cellH).stroke().restore();

        const payload = buildBoxPayload({
          boxUid: box.boxUid,
          orderNumber: order.orderNumber,
          productCode: box.product.code,
          batchNo: box.batchNo,
          expiryDate: box.expiryDate,
          donorName: order.donorName || null,
        });

        const qrBuf = await payloadToPngBuffer(payload);

        // ✅ QR vertically centered inside the label cell (less “crowded”)
        const qrX = x + leftPad;
        const qrY = y + (cellH - qrSize) / 2;

        doc.image(qrBuf, qrX, qrY, { width: qrSize, height: qrSize });

        // Text area to the right
        const tx = qrX + qrSize + gap;
        const tw = x + cellW - rightPad - tx;

        // tighter, consistent text spacing
        const expStr = new Date(box.expiryDate).toISOString().slice(0, 10);

        // boxUid can wrap nicely because of hyphens
        doc.fontSize(7).fillColor("#000000").text(box.boxUid, tx, y + mmToPt(4.0), {
          width: tw,
        });

        doc.fontSize(6).fillColor("#222222").text(`Batch: ${box.batchNo}`, tx, y + mmToPt(11.0), {
          width: tw,
        });

        doc.fontSize(6).fillColor("#222222").text(`Exp: ${expStr}`, tx, y + mmToPt(15.5), {
          width: tw,
        });

        if (order.donorName) {
          doc.fontSize(6).fillColor("#222222").text(`Donor: ${order.donorName}`, tx, y + mmToPt(20.0), {
            width: tw,
            ellipsis: true,
          });
        }
      }

      doc.end();
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

module.exports = router;
