// QR label runs: every batch of box labels generated at a warehouse, for
// reprinting. A run is either a goods receipt against a purchase order or a
// "Generate boxes" run without a PO.
//
//   GET /api/labels/runs?warehouseId=&take=
//   GET /api/labels/locations?implementationId=          boxes at each location
//   GET /api/labels/locations/:facilityId/print/a3       labels of the boxes there now

const express = require("express");

const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { requireAuth } = require("../middleware/auth");
const { requireModule } = require("../middleware/modules");
const { requireRole } = require("../middleware/rbac");
const { visibleWarehouseIds } = require("../warehouse/common");
const { isSuperAdmin, countryWideImplementationId, locationWithDescendants } = require("../auth/access");
const { writeA3Labels, sortBoxes } = require("../utils/labelSheet");

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

// ---------------------------------------------------------------------------
// Labels by location: reprint QR labels for the boxes now at a warehouse or a
// site (e.g. cartons that reached a site without labels).
// ---------------------------------------------------------------------------
const PRINT_ROLES = ["SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"];
const PRESENT = ["IN_WAREHOUSE", "IN_FACILITY"];

/** Locations this user may print for (null = all). */
async function visibleLocationWhere(req) {
  if (isSuperAdmin(req.user)) return req.query.implementationId ? { implementationId: String(req.query.implementationId) } : {};
  const countryId = countryWideImplementationId(req.user);
  if (countryId) return { implementationId: countryId };
  if (req.user.facilityType === "WAREHOUSE" && req.user.facilityId) {
    return { id: { in: await locationWithDescendants(req.user.facilityId) } };
  }
  return null;
}

router.get("/locations", requireRole(...PRINT_ROLES), async (req, res) => {
  try {
    const where = await visibleLocationWhere(req);
    if (!where) return res.json({ rows: [] });
    const locations = await prisma.facility.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        stockLocationType: true,
        implementationId: true,
        county: { select: { name: true } },
        parentStockLocation: { select: { name: true } },
      },
    });
    const counts = await prisma.box.groupBy({
      by: ["currentFacilityId", "productId"],
      where: { currentFacilityId: { in: locations.map((l) => l.id) }, status: { in: PRESENT } },
      _count: { _all: true },
    });
    const products = await prisma.product.findMany({
      where: { id: { in: [...new Set(counts.map((c) => c.productId))] } },
      select: { id: true, code: true, name: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));
    const byLocation = new Map();
    for (const c of counts) {
      const list = byLocation.get(c.currentFacilityId) || [];
      list.push({ ...productById.get(c.productId), boxes: c._count._all });
      byLocation.set(c.currentFacilityId, list);
    }
    const order = { CENTRAL_WAREHOUSE: 0, FIELD_BASE_WAREHOUSE: 1 };
    const rows = locations
      .map((l) => {
        const items = byLocation.get(l.id) || [];
        return {
          id: l.id,
          code: l.code,
          name: l.name,
          type: l.type,
          stockLocationType: l.stockLocationType,
          implementationId: l.implementationId,
          county: l.county?.name || null,
          parent: l.parentStockLocation?.name || null,
          boxes: items.reduce((n, i) => n + i.boxes, 0),
          products: items,
        };
      })
      .filter((r) => r.boxes > 0)
      .sort((a, b) => (order[a.stockLocationType] ?? 2) - (order[b.stockLocationType] ?? 2) || a.name.localeCompare(b.name));
    return res.json({ rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.get("/locations/:facilityId/print/a3", requireRole(...PRINT_ROLES), async (req, res) => {
  try {
    const where = await visibleLocationWhere(req);
    const facilityId = String(req.params.facilityId);
    const location = where ? await prisma.facility.findFirst({ where: { AND: [where, { id: facilityId }] }, select: { id: true, code: true } }) : null;
    if (!location) return res.status(404).json({ message: "Location not found" });
    const boxes = await prisma.box.findMany({
      where: { currentFacilityId: location.id, status: { in: PRESENT }, ...(req.query.productId ? { productId: String(req.query.productId) } : {}) },
      include: { product: true, donor: { select: { name: true } }, order: { select: { orderNumber: true, donorName: true } } },
    });
    if (!boxes.length) return res.status(404).json({ message: "No boxes at this location" });
    await writeA3Labels(res, sortBoxes(boxes), `${location.code}_labels_A3_80up.pdf`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
