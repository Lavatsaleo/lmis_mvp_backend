// QR label sheets for cartons.
//
//   carton (default): A4 portrait, 8 labels of 99.1 x 67.7 mm (standard A4 8-up
//                     label stock, e.g. Avery L7165; also prints on plain A4 to
//                     cut out). 52 mm QR: reads from about half a metre. Sized
//                     for the SQ-LNS carton (395 x 285 x 195 mm, Nutriset
//                     technical data sheet 2025): fits its 285 x 195 mm end.
//   small:            A3 landscape, 80 labels of 50.9 x 28.4 mm, 19.9 mm QR
//                     (the original sheet).
//
// The QR is drawn as vector squares (sharp at any size, unlike a scaled
// picture) with error correction level Q, so a scuffed label still scans.
// Each box needs: boxUid, batchNo, expiryDate, product.{code,name},
// donor?.name, order.{orderNumber,donorName}.

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const { buildBoxPayload } = require("./qr");

const mmToPt = (mm) => (mm * 72) / 25.4;

const FORMATS = {
  carton: {
    page: [210, 297],
    cols: 2,
    rows: 4,
    label: [99.1, 67.7],
    // Avery L7165 geometry: 4.65 mm side margin, 2.5 mm between columns, 13.1 mm top.
    origin: [4.65, 13.1],
    pitch: [101.6, 67.7],
    qr: 52,
  },
  small: {
    page: [420, 297],
    cols: 8,
    rows: 10,
    label: [50.9, 28.4],
    origin: [(420 - 50.9 * 8) / 2, (297 - 28.4 * 10) / 2],
    pitch: [50.9, 28.4],
    qr: 19.9,
  },
};
const formatOf = (name) => (FORMATS[name] ? name : "carton");

// Label order follows the running number (…-2 before …-10).
const collator = new Intl.Collator("en", { numeric: true });
const sortBoxes = (boxes) => boxes.sort((x, y) => collator.compare(x.boxUid, y.boxUid));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = (d) => {
  const x = new Date(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

/** Draw a QR code as vector squares, `size` points wide, quiet zone included. */
function drawQr(doc, text, x, y, size) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "Q" });
  const n = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  doc.save().rect(x, y, size, size).fill("#FFFFFF");
  doc.fillColor("#000000");
  for (let r = 0; r < n; r++) {
    let run = -1;
    for (let c = 0; c <= n; c++) {
      const dark = c < n && qr.modules.get(r, c);
      if (dark && run < 0) run = c;
      if (!dark && run >= 0) {
        // One rectangle per run of dark modules; a hair of overlap avoids white seams.
        doc.rect(x + (quiet + run) * cell, y + (quiet + r) * cell, (c - run) * cell + 0.05, cell + 0.05);
        run = -1;
      }
    }
  }
  doc.fill("#000000").restore();
}

function cartonLabel(doc, box, x, y, f) {
  const [wMm, hMm] = f.label;
  const w = mmToPt(wMm);
  const h = mmToPt(hMm);
  const pad = mmToPt(3);
  const qr = mmToPt(f.qr);
  doc.save().lineWidth(0.4).strokeColor("#D0D0D0").rect(x, y, w, h).stroke().restore();
  drawQr(doc, payloadFor(box), x + pad, y + (h - qr) / 2, qr);

  const tx = x + pad + qr + mmToPt(3);
  const tw = x + w - pad - tx;
  let ty = y + mmToPt(6);
  const line = (text, size, font = "Helvetica", color = "#000000", gap = 1.6) => {
    if (!text) return;
    doc.font(font).fontSize(size).fillColor(color).text(String(text), tx, ty, { width: tw, lineBreak: true });
    ty = doc.y + mmToPt(gap);
  };
  line(box.boxUid, 13, "Helvetica-Bold", "#000000", 2.4);
  line(box.product?.name || box.product?.code, 10, "Helvetica-Bold");
  line(`Batch ${box.batchNo}`, 9.5);
  line(`Expiry ${longDate(box.expiryDate)}`, 9.5, "Helvetica-Bold");
  const donor = box.donor?.name || box.order?.donorName;
  if (donor) line(`Donor: ${donor}`, 8.5, "Helvetica", "#222222");
  doc.font("Helvetica").fontSize(6.5).fillColor("#666666").text("Anchor · scan to track", tx, y + h - mmToPt(6), { width: tw });
}

function smallLabel(doc, box, x, y, f) {
  const w = mmToPt(f.label[0]);
  const h = mmToPt(f.label[1]);
  const qr = mmToPt(f.qr);
  doc.save().lineWidth(0.4).strokeColor("#E0E0E0").rect(x, y, w, h).stroke().restore();
  const qx = x + mmToPt(2);
  drawQr(doc, payloadFor(box), qx, y + (h - qr) / 2, qr);
  const tx = qx + qr + mmToPt(2);
  const tw = x + w - mmToPt(1.8) - tx;
  doc.font("Helvetica").fontSize(7).fillColor("#000000").text(box.boxUid, tx, y + mmToPt(4.0), { width: tw });
  doc.fontSize(6).fillColor("#222222").text(`Batch: ${box.batchNo}`, tx, y + mmToPt(11.0), { width: tw });
  doc.fontSize(6).fillColor("#222222").text(`Exp: ${new Date(box.expiryDate).toISOString().slice(0, 10)}`, tx, y + mmToPt(15.5), { width: tw });
  const donor = box.donor?.name || box.order?.donorName;
  if (donor) doc.fontSize(6).fillColor("#222222").text(`Donor: ${donor}`, tx, y + mmToPt(20.0), { width: tw, ellipsis: true });
}

function payloadFor(box) {
  return buildBoxPayload({
    boxUid: box.boxUid,
    orderNumber: box.order?.orderNumber,
    productCode: box.product?.code,
    batchNo: box.batchNo,
    expiryDate: box.expiryDate,
    donorName: box.order?.donorName || null,
  });
}

/** Write a label sheet PDF for `boxes` to the response. */
async function writeA3Labels(res, boxes, filename, formatName) {
  const name = formatOf(formatName);
  const f = FORMATS[name];
  res.setHeader("Content-Type", "application/pdf");
  const base = String(filename).replace(/(_A3_80up)?\.pdf$/i, "");
  const file = `${base}_${name === "carton" ? "A4_8up" : "A3_80up"}.pdf`.replace(/[^A-Za-z0-9._-]+/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${file}"`);

  const doc = new PDFDocument({ size: [mmToPt(f.page[0]), mmToPt(f.page[1])], margins: { top: 0, left: 0, right: 0, bottom: 0 } });
  doc.pipe(res);
  const perPage = f.cols * f.rows;
  for (let i = 0; i < boxes.length; i++) {
    if (i > 0 && i % perPage === 0) doc.addPage();
    const k = i % perPage;
    const x = mmToPt(f.origin[0] + (k % f.cols) * f.pitch[0]);
    const y = mmToPt(f.origin[1] + Math.floor(k / f.cols) * f.pitch[1]);
    if (name === "carton") cartonLabel(doc, boxes[i], x, y, f);
    else smallLabel(doc, boxes[i], x, y, f);
  }
  doc.end();
}

module.exports = { writeA3Labels, sortBoxes, FORMATS };
