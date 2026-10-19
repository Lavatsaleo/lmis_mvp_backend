// QR label runs: every batch of box labels generated at a warehouse, for
// reprinting. A run is either a goods receipt against a purchase order or a
// "Generate boxes" run without a PO.
//
//   GET /api/labels/runs?warehouseId=&take=

const express = require("express");

const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
const { requireModule } = require("../middleware/modules");
const { visibleWarehouseIds } = require("../warehouse/common");

const router = express.Router();
router.use(requireAuth, requireModule("LOGISTICS", "PHARMACY"));

router.get("/runs", async (req, res) => {
  try {
    let ids = await visibleWarehouseIds(req, prisma);
    if (req.query.warehouseId) {
      const wh = String(req.query.warehouseId);
      if (ids !== null && !ids.includes(wh)) return res.json({ rows: [] });
      ids = [wh];
    }
    if (ids !== null && !ids.length) return res.json({ rows: [] });
    const take = Math.min(100, Math.max(1, Number.parseInt(req.query.take || "30", 10) || 30));

    const [receipts, generated] = await Promise.all([
      prisma.goodsReceipt.findMany({
        where: ids === null ? {} : { warehouseId: { in: ids } },
        orderBy: { receivedAt: "desc" },
        take,
        include: {
          warehouse: { select: { id: true, name: true } },
          receivedBy: { select: { fullName: true } },
          purchaseOrder: { select: { id: true, poNumber: true, order: { select: { id: true } } } },
          lines: { select: { batchNo: true, packs: true } },
          _count: { select: { boxes: true } },
        },
      }),
      prisma.$queryRaw`
        SELECT b.orderId AS orderId, o.orderNumber AS orderNumber, b.generationRequestId AS generationRequestId,
               e.toFacilityId AS warehouseId, MIN(e.createdAt) AS at, COUNT(*) AS boxes,
               GROUP_CONCAT(DISTINCT b.batchNo) AS batches, MIN(u.fullName) AS byName
        FROM \`BoxEvent\` e
        JOIN \`Box\` b ON b.id = e.boxId
        JOIN \`Order\` o ON o.id = b.orderId
        JOIN \`User\` u ON u.id = e.performedByUserId
        WHERE e.type = 'QR_CREATED' AND b.goodsReceiptId IS NULL AND b.generationRequestId IS NOT NULL
          ${ids === null ? Prisma.empty : Prisma.sql`AND e.toFacilityId IN (${Prisma.join(ids)})`}
        GROUP BY b.orderId, o.orderNumber, b.generationRequestId, e.toFacilityId
        ORDER BY at DESC
        LIMIT ${take}`,
    ]);
    const whIds = [...new Set(generated.map((g) => g.warehouseId))];
    const whs = await prisma.facility.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true } });
    const whName = new Map(whs.map((w) => [w.id, w.name]));

    const rows = [
      ...receipts.map((r) => ({
        kind: "PO_RECEIPT",
        at: r.receivedAt,
        reference: r.grnNumber,
        poNumber: r.purchaseOrder.poNumber,
        purchaseOrderId: r.purchaseOrder.id,
        warehouse: r.warehouse.name,
        boxes: r._count.boxes,
        batches: [...new Set(r.lines.map((l) => l.batchNo))].join(", "),
        by: r.receivedBy.fullName,
        orderId: r.purchaseOrder.order?.id || null,
        goodsReceiptId: r.id,
      })),
      ...generated.map((g) => ({
        kind: "GENERATED",
        at: g.at,
        reference: g.orderNumber,
        poNumber: null,
        warehouse: whName.get(g.warehouseId) || "",
        boxes: Number(g.boxes),
        batches: g.batches || "",
        by: g.byName,
        orderId: g.orderId,
        generationRequestId: g.generationRequestId,
      })),
    ]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, take);
    return res.json({ rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
