// A3 landscape QR label sheet, 80-up (8 x 10). Label cell 50.9 x 28.4 mm, QR 19.9 mm.
// Used for a whole order, one delivery (GRN), one generation run, or the boxes
// currently at a location. Each box needs: boxUid, batchNo, expiryDate,
// product.code, donor?.name, order.orderNumber, order.donorName.

const PDFDocument = require("pdfkit");
const { buildBoxPayload, payloadToPngBuffer } = require("./qr");

const mmToPt = (mm) => (mm * 72) / 25.4;

const PAGE_W_MM = 420;
const PAGE_H_MM = 297;
const COLS = 8;
const ROWS = 10;
const LABEL_W_MM = 50.9;
const LABEL_H_MM = 28.4;
const QR_MM = 19.9;

// Label order follows the running number (…-2 before …-10).
const collator = new Intl.Collator("en", { numeric: true });
const sortBoxes = (boxes) => boxes.sort((x, y) => collator.compare(x.boxUid, y.boxUid));

async function writeA3Labels(res, boxes, filename) {
  const marginX = mmToPt((PAGE_W_MM - LABEL_W_MM * COLS) / 2);
  const marginY = mmToPt((PAGE_H_MM - LABEL_H_MM * ROWS) / 2);
  const cellW = mmToPt(LABEL_W_MM);
  const cellH = mmToPt(LABEL_H_MM);
  const qrSize = mmToPt(QR_MM);
  const leftPad = mmToPt(2.0);
  const rightPad = mmToPt(1.8);
  const gap = mmToPt(2.0);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]+/g, "_")}"`);

  const doc = new PDFDocument({ size: [mmToPt(PAGE_W_MM), mmToPt(PAGE_H_MM)], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
  doc.pipe(res);

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (i > 0 && i % (COLS * ROWS) === 0) doc.addPage();
    const indexOnPage = i % (COLS * ROWS);
    const x = marginX + (indexOnPage % COLS) * cellW;
    const y = marginY + Math.floor(indexOnPage / COLS) * cellH;

    doc.save().lineWidth(0.4).strokeColor("#E0E0E0").rect(x, y, cellW, cellH).stroke().restore();

    const payload = buildBoxPayload({
      boxUid: box.boxUid,
      orderNumber: box.order?.orderNumber,
      productCode: box.product.code,
      batchNo: box.batchNo,
      expiryDate: box.expiryDate,
      donorName: box.order?.donorName || null,
    });
    const qrBuf = await payloadToPngBuffer(payload);
    const qrX = x + leftPad;
    doc.image(qrBuf, qrX, y + (cellH - qrSize) / 2, { width: qrSize, height: qrSize });

    const tx = qrX + qrSize + gap;
    const tw = x + cellW - rightPad - tx;
    const expStr = new Date(box.expiryDate).toISOString().slice(0, 10);
    doc.fontSize(7).fillColor("#000000").text(box.boxUid, tx, y + mmToPt(4.0), { width: tw });
    doc.fontSize(6).fillColor("#222222").text(`Batch: ${box.batchNo}`, tx, y + mmToPt(11.0), { width: tw });
    doc.fontSize(6).fillColor("#222222").text(`Exp: ${expStr}`, tx, y + mmToPt(15.5), { width: tw });
    // The box's own donor (PO stock), else the order's free-text donor.
    const donorLabel = box.donor?.name || box.order?.donorName;
    if (donorLabel) {
      doc.fontSize(6).fillColor("#222222").text(`Donor: ${donorLabel}`, tx, y + mmToPt(20.0), { width: tw, ellipsis: true });
    }
  }
  doc.end();
}

module.exports = { writeA3Labels, sortBoxes };
