const express = require('express');
const router = express.Router();

const prisma = require('../lib/prisma');
const PDFDocument = require('pdfkit');

const { requireAuth } = require('../middleware/auth');

function mmToPt(mm) {
  return (mm * 72) / 25.4;
}

function safeDate(d) {
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// GET /api/shipments
// Query (optional): status=DISPATCHED|RECEIVED|CANCELLED
// Query (optional): includeReceived=true  (only relevant when status is not provided)
// Scoping:
//  - SUPER_ADMIN: can filter by fromWarehouseId/toFacilityId
//  - WAREHOUSE_OFFICER (or users assigned to a warehouse): only own warehouse shipments
//  - FACILITY users: only shipments to their facility
// ---------------------------------------------------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).trim().toUpperCase() : null;
    const includeReceived =
      String(req.query.includeReceived || '').toLowerCase() === 'true' ||
      String(req.query.includeReceived || '') === '1';

    const where = {};

    // Default behaviour (when status is NOT provided):
    // - Facility users: hide RECEIVED shipments so the manifest picker stays short.
    // - Warehouse users: show all by default.
    // - Client can always request history via includeReceived=true OR status=RECEIVED.
    if (status) {
      where.status = status;
    } else if (
      req.user.role !== 'SUPER_ADMIN' &&
      !(req.user.role === 'WAREHOUSE_OFFICER' || req.user.facilityType === 'WAREHOUSE') &&
      !includeReceived
    ) {
      where.status = { in: ['DISPATCHED'] };
    }

    if (req.user.role === 'SUPER_ADMIN') {
      if (req.query.fromWarehouseId) where.fromWarehouseId = String(req.query.fromWarehouseId);
      if (req.query.toFacilityId) where.toFacilityId = String(req.query.toFacilityId);
    } else if (req.user.role === 'WAREHOUSE_OFFICER' || req.user.facilityType === 'WAREHOUSE') {
      const myWarehouseId = req.user.warehouseId
        ? String(req.user.warehouseId)
        : req.user.facilityId
        ? String(req.user.facilityId)
        : null;

      if (!myWarehouseId) return res.json([]);
      where.fromWarehouseId = myWarehouseId;
    } else {
      const myFacilityId = req.user.facilityId ? String(req.user.facilityId) : null;
      if (!myFacilityId) return res.json([]);
      where.toFacilityId = myFacilityId;
    }

    const shipments = await prisma.shipment.findMany({
      where,
      orderBy: { dispatchedAt: 'desc' },
      take: 100,
      include: {
        fromWarehouse: { select: { id: true, code: true, name: true } },
        toFacility: { select: { id: true, code: true, name: true } },
        dispatchedBy: { select: { id: true, fullName: true, role: true } },
        receivedBy: { select: { id: true, fullName: true, role: true } },
        _count: { select: { items: true } },
      },
    });

    return res.json(
      shipments.map((s) => ({
        id: s.id,
        manifestNo: s.manifestNo,
        status: s.status,
        note: s.note,

        fromWarehouse: s.fromWarehouse,
        toFacility: s.toFacility,

        dispatchedBy: s.dispatchedBy,
        receivedBy: s.receivedBy,

        dispatchedAt: s.dispatchedAt,
        receivedAt: s.receivedAt || null,

        itemCount: s._count.items,
        boxesCount: s._count.items,

        waybillUrl: `/api/shipments/${s.id}/waybill.pdf`,
      }))
    );
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error', error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/shipments/:shipmentId
// Returns shipment + items + received flags
// ---------------------------------------------------------------------------
router.get('/:shipmentId', requireAuth, async (req, res) => {
  try {
    const { shipmentId } = req.params;

    const shipment = await prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
      include: {
        fromWarehouse: { select: { id: true, code: true, name: true } },
        toFacility: { select: { id: true, code: true, name: true } },
        dispatchedBy: { select: { id: true, fullName: true, role: true } },
        receivedBy: { select: { id: true, fullName: true, role: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            box: {
              select: {
                id: true,
                boxUid: true,
                batchNo: true,
                expiryDate: true,
                status: true,
                product: { select: { code: true, name: true } },
              },
            },
          },
        },
      },
    });

    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    // Scoping
    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.role === 'WAREHOUSE_OFFICER' || req.user.facilityType === 'WAREHOUSE') {
        const myWarehouseId = req.user.warehouseId
          ? String(req.user.warehouseId)
          : req.user.facilityId
          ? String(req.user.facilityId)
          : null;

        if (!myWarehouseId || String(shipment.fromWarehouseId) !== myWarehouseId) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      } else {
        const myFacilityId = req.user.facilityId ? String(req.user.facilityId) : null;
        if (!myFacilityId || String(shipment.toFacilityId) !== myFacilityId) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      }
    }

    return res.json(shipment);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error', error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/shipments/:shipmentId/waybill.pdf
// Generates a simple printable manifest/waybill
// ---------------------------------------------------------------------------
router.get('/:shipmentId/waybill.pdf', requireAuth, async (req, res) => {
  try {
    const { shipmentId } = req.params;

    const shipment = await prisma.shipment.findUnique({
      where: { id: String(shipmentId) },
      include: {
        fromWarehouse: { select: { code: true, name: true } },
        toFacility: { select: { code: true, name: true } },
        dispatchedBy: { select: { fullName: true } },
        items: {
          orderBy: { id: 'asc' },
          include: {
            box: {
              select: {
                boxUid: true,
                batchNo: true,
                expiryDate: true,
                product: { select: { code: true, name: true } },
                order: { select: { orderNumber: true, donorName: true } },
              },
            },
          },
        },
      },
    });

    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    // Scoping: same rules as detail
    if (req.user.role !== 'SUPER_ADMIN') {
      if (req.user.role === 'WAREHOUSE_OFFICER' || req.user.facilityType === 'WAREHOUSE') {
        const myWarehouseId = req.user.warehouseId
          ? String(req.user.warehouseId)
          : req.user.facilityId
          ? String(req.user.facilityId)
          : null;

        if (!myWarehouseId || String(shipment.fromWarehouseId) !== myWarehouseId) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      } else {
        const myFacilityId = req.user.facilityId ? String(req.user.facilityId) : null;
        if (!myFacilityId || String(shipment.toFacilityId) !== myFacilityId) {
          return res.status(403).json({ message: 'Forbidden' });
        }
      }
    }

    // PDF setup
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Waybill_${shipment.manifestNo}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    doc.pipe(res);

    // Header
    doc.fontSize(16).font('Helvetica-Bold').text('WAYBILL / MANIFEST', { align: 'center' });
    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica');
    doc.text(`Manifest No: ${shipment.manifestNo}`);
    doc.text(`Date: ${safeDate(shipment.dispatchedAt)}`);
    doc.text(`From (Warehouse): ${shipment.fromWarehouse.name} (${shipment.fromWarehouse.code})`);
    doc.text(`To (Facility): ${shipment.toFacility.name} (${shipment.toFacility.code})`);
    doc.text(`Dispatched by: ${shipment.dispatchedBy.fullName}`);

    const first = shipment.items[0]?.box;
    const donor = first?.order?.donorName || '';
    const orderNo = first?.order?.orderNumber || '';
    if (orderNo) doc.text(`Order No: ${orderNo}`);
    if (donor) doc.text(`Donor: ${donor}`);

    doc.moveDown(0.8);

    const startX = doc.x;
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const col1 = startX;
    const col2 = startX + pageW * 0.12;
    const col3 = startX + pageW * 0.62;
    const col4 = startX + pageW * 0.77;
    const col5 = startX + pageW * 0.90;

    doc.font('Helvetica-Bold');
    doc.text('#', col1, doc.y, { width: pageW * 0.10 });
    doc.text('Box UID', col2, doc.y, { width: pageW * 0.48 });
    doc.text('Batch', col3, doc.y, { width: pageW * 0.14 });
    doc.text('Expiry', col4, doc.y, { width: pageW * 0.12 });
    doc.text('Check', col5, doc.y, { width: pageW * 0.10 });
    doc.moveDown(0.4);
    doc.font('Helvetica');

    const rowH = 14;
    let i = 1;

    for (const it of shipment.items) {
      const b = it.box;
      if (doc.y > doc.page.height - doc.page.margins.bottom - 90) {
        doc.addPage();
      }
      const y = doc.y;
      doc.text(String(i), col1, y, { width: pageW * 0.10 });
      doc.text(b.boxUid, col2, y, { width: pageW * 0.48 });
      doc.text(b.batchNo || '', col3, y, { width: pageW * 0.14 });
      doc.text(safeDate(b.expiryDate), col4, y, { width: pageW * 0.12 });
      doc.rect(col5 + 6, y + 2, 10, 10).stroke();
      doc.moveDown(0.0);
      doc.y = y + rowH;
      i += 1;
    }

    doc.moveDown(1.2);
    doc.font('Helvetica-Bold').text(`Total boxes: ${shipment.items.length}`);

    doc.moveDown(1.2);
    doc.font('Helvetica');
    doc.text('Courier details (to be filled):', { underline: false });
    doc.moveDown(0.5);
    doc.text('Courier Name: __________________________   Vehicle/Plate: __________________________');
    doc.moveDown(0.6);
    doc.text('Warehouse Signature: _____________________   Date: _________________________________');
    doc.moveDown(0.6);
    doc.text('Facility Receiver Name: ___________________   Signature: ___________________________');
    doc.moveDown(0.6);
    doc.text('Date Received: ____________________________');

    doc.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error', error: String(err.message || err) });
  }
});

module.exports = router;