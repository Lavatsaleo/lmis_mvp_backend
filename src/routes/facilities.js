const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

function normalizeType(type) {
  if (!type) return "FACILITY";
  const t = String(type).trim().toUpperCase();
  return t === "WAREHOUSE" ? "WAREHOUSE" : "FACILITY";
}

/**
 * POST /api/facilities
 * Roles: SUPER_ADMIN
 * Body:
 *  {
 *    code, name,
 *    type: "WAREHOUSE" | "FACILITY",
 *    warehouseId?: string   // only for FACILITY, links facility to warehouse
 *  }
 */
router.post("/", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const { code, name, type, warehouseId } = req.body || {};
    if (!code || !name) {
      return res.status(400).json({ message: "code and name are required" });
    }

    const facilityType = normalizeType(type);

    // If creating a FACILITY and warehouseId is provided, validate it exists + is a warehouse
    if (facilityType === "FACILITY" && warehouseId) {
      const wh = await prisma.facility.findUnique({ where: { id: String(warehouseId) } });
      if (!wh) return res.status(400).json({ message: "warehouseId not found" });
      if (wh.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "warehouseId must reference a WAREHOUSE facility" });
      }
    }

    const facility = await prisma.facility.create({
      data: {
        code: String(code).trim(),
        name: String(name).trim(),
        type: facilityType,
        warehouseId: facilityType === "FACILITY" ? (warehouseId ? String(warehouseId) : null) : null,
      },
    });

    return res.status(201).json(facility);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

/**
 * PATCH /api/facilities/:facilityId/link-warehouse
 * Roles: SUPER_ADMIN
 * Body: { warehouseId } OR { warehouseCode }
 */
router.patch(
  "/:facilityId/link-warehouse",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { facilityId } = req.params;
      const { warehouseId, warehouseCode } = req.body || {};

      if (!warehouseId && !warehouseCode) {
        return res.status(400).json({ message: "Provide warehouseId or warehouseCode" });
      }

      const facility = await prisma.facility.findUnique({ where: { id: String(facilityId) } });
      if (!facility) return res.status(404).json({ message: "Facility not found" });
      if (facility.type !== "FACILITY") {
        return res.status(400).json({ message: "Only FACILITY records can be linked to a warehouse" });
      }

      let wh = null;
      if (warehouseId) {
        wh = await prisma.facility.findUnique({ where: { id: String(warehouseId) } });
      } else {
        wh = await prisma.facility.findUnique({ where: { code: String(warehouseCode).trim() } });
      }

      if (!wh) return res.status(404).json({ message: "Warehouse not found" });
      if (wh.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "Target must be a WAREHOUSE facility" });
      }

      const updated = await prisma.facility.update({
        where: { id: facility.id },
        data: { warehouseId: wh.id },
        include: { warehouse: true },
      });

      return res.json({ message: "Linked", facility: updated });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * PATCH /api/facilities/bulk/link-warehouse
 * Roles: SUPER_ADMIN
 * Body:
 *  {
 *    warehouseId?: string,
 *    warehouseCode?: string,
 *    facilityIds?: string[],
 *    facilityCodes?: string[]
 *  }
 *
 * Use this to quickly link your 15 facilities to Warehouse A.
 */
router.patch(
  "/bulk/link-warehouse",
  requireAuth,
  requireRole("SUPER_ADMIN"),
  async (req, res) => {
    try {
      const { warehouseId, warehouseCode, facilityIds, facilityCodes } = req.body || {};

      if (!warehouseId && !warehouseCode) {
        return res.status(400).json({ message: "Provide warehouseId or warehouseCode" });
      }
      const hasIds = Array.isArray(facilityIds) && facilityIds.length > 0;
      const hasCodes = Array.isArray(facilityCodes) && facilityCodes.length > 0;
      if (!hasIds && !hasCodes) {
        return res.status(400).json({ message: "Provide facilityIds[] or facilityCodes[]" });
      }

      // find warehouse
      let wh = null;
      if (warehouseId) {
        wh = await prisma.facility.findUnique({ where: { id: String(warehouseId) } });
      } else {
        wh = await prisma.facility.findUnique({ where: { code: String(warehouseCode).trim() } });
      }
      if (!wh) return res.status(404).json({ message: "Warehouse not found" });
      if (wh.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "Target must be a WAREHOUSE facility" });
      }

      // find facilities + validate missing
      let facilities = [];
      let missing = [];

      if (hasIds) {
        facilities = await prisma.facility.findMany({
          where: { id: { in: facilityIds.map(String) } },
        });
        const foundIds = new Set(facilities.map((f) => f.id));
        missing = facilityIds.filter((id) => !foundIds.has(String(id)));
      } else {
        facilities = await prisma.facility.findMany({
          where: { code: { in: facilityCodes.map((c) => String(c).trim()) } },
        });
        const foundCodes = new Set(facilities.map((f) => f.code));
        missing = facilityCodes.filter((c) => !foundCodes.has(String(c).trim()));
      }

      // only FACILITY records can be linked
      const nonFacility = facilities.filter((f) => f.type !== "FACILITY").map((f) => ({ id: f.id, code: f.code, type: f.type }));
      if (nonFacility.length > 0) {
        return res.status(400).json({
          message: "Some records are not FACILITY and cannot be linked",
          nonFacility,
        });
      }

      // update
      const idsToUpdate = facilities.map((f) => f.id);
      const result = await prisma.facility.updateMany({
        where: { id: { in: idsToUpdate } },
        data: { warehouseId: wh.id },
      });

      return res.json({
        message: "Bulk link complete",
        warehouse: { id: wh.id, code: wh.code, name: wh.name },
        requested: hasIds ? facilityIds.length : facilityCodes.length,
        updated: result.count,
        missing,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * GET /api/facilities
 * Roles:
 *  - SUPER_ADMIN: all
 *  - WAREHOUSE_OFFICER: own warehouse + facilities under it
 *  - VIEWER: if assigned to a warehouse -> warehouse + facilities under it; else -> own facility
 *  - FACILITY_OFFICER/CLINICIAN: only own facility
 *
 * Optional query: ?type=WAREHOUSE or ?type=FACILITY
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const type = req.query.type ? normalizeType(req.query.type) : null;

    if (req.user.role === "SUPER_ADMIN") {
      const where = {};
      if (type) where.type = type;

      const facilities = await prisma.facility.findMany({
        where,
        orderBy: [{ type: "asc" }, { name: "asc" }],
      });
      return res.json(facilities);
    }

    // WAREHOUSE_OFFICER or VIEWER assigned to a warehouse
    if (req.user.role === "WAREHOUSE_OFFICER" || req.user.role === "VIEWER") {
      if (!req.user.facilityId) return res.json([]);

      const assigned = await prisma.facility.findUnique({ where: { id: req.user.facilityId } });
      if (!assigned) return res.json([]);

      // If assigned to warehouse: show warehouse + its facilities (good for dashboard viewer)
      if (assigned.type === "WAREHOUSE") {
        if (type === "WAREHOUSE") return res.json([assigned]);

        if (type === "FACILITY") {
          const facilities = await prisma.facility.findMany({
            where: { type: "FACILITY", warehouseId: assigned.id },
            orderBy: [{ name: "asc" }],
          });
          return res.json(facilities);
        }

        const facilities = await prisma.facility.findMany({
          where: {
            OR: [{ id: assigned.id }, { warehouseId: assigned.id }],
          },
          orderBy: [{ type: "asc" }, { name: "asc" }],
        });
        return res.json(facilities);
      }

      // If assigned to a normal facility: only their facility
      if (type && assigned.type !== type) return res.json([]);
      return res.json([assigned]);
    }

    // Other facility users: only their facility
    if (!req.user.facilityId) return res.json([]);
    const fac = await prisma.facility.findUnique({ where: { id: req.user.facilityId } });
    if (!fac) return res.json([]);
    if (type && fac.type !== type) return res.json([]);
    return res.json([fac]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

/**
 * GET /api/facilities/me
 * Returns:
 *  - facility (assigned to user)
 *  - warehouse (if facility is a FACILITY and is linked to a warehouse)
 */
router.get("/me", requireAuth, async (req, res) => {
  try {
    if (!req.user.facilityId) return res.json({ facility: null, warehouse: null });

    const facility = await prisma.facility.findUnique({
      where: { id: req.user.facilityId },
      include: { warehouse: true },
    });

    if (!facility) return res.json({ facility: null, warehouse: null });

    const warehouse = facility.type === "WAREHOUSE" ? facility : facility.warehouse;

    return res.json({ facility, warehouse });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
