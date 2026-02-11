const QRCode = require("qrcode");

function buildBoxPayload({ boxUid, orderNumber, productCode, batchNo, expiryDate }) {
  // Keep it compact but sufficient to validate batch/expiry/order at scan time
  return JSON.stringify({
    boxUid,
    orderNumber,
    productCode,
    batchNo,
    expiry: new Date(expiryDate).toISOString().slice(0, 10), // YYYY-MM-DD
  });
}

async function payloadToPngBuffer(payload) {
  const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 256 });
  const base64 = dataUrl.split(",")[1];
  return Buffer.from(base64, "base64");
}

module.exports = { buildBoxPayload, payloadToPngBuffer };
