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
 * GET /api/facilities
 * Roles:
 *  - SUPER_ADMIN: all
 *  - WAREHOUSE_OFFICER: own warehouse + facilities under it
 *  - FACILITY_OFFICER/CLINICIAN/VIEWER: only own facility (and optionally its warehouse if requested via /me)
 *
 * Optional query: ?type=WAREHOUSE or ?type=FACILITY
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const type = req.query.type ? normalizeType(req.query.type) : null;

    // --- SUPER_ADMIN: see all (optionally filtered by type)
    if (req.user.role === "SUPER_ADMIN") {
      const where = {};
      if (type) where.type = type;

      const facilities = await prisma.facility.findMany({
        where,
        orderBy: [{ type: "asc" }, { name: "asc" }],
      });

      return res.json(facilities);
    }

    // --- WAREHOUSE_OFFICER: must be assigned to a warehouse (User.facilityId = warehouse id)
    if (req.user.role === "WAREHOUSE_OFFICER") {
      if (!req.user.facilityId) {
        return res.status(400).json({ message: "Warehouse officer has no facilityId set" });
      }

      const wh = await prisma.facility.findUnique({ where: { id: req.user.facilityId } });
      if (!wh) return res.status(400).json({ message: "Your assigned warehouse facilityId was not found" });
      if (wh.type !== "WAREHOUSE") {
        return res.status(400).json({ message: "Your facilityId must point to a WAREHOUSE facility" });
      }

      // If caller filters type=WAREHOUSE -> return only their warehouse
      if (type === "WAREHOUSE") return res.json([wh]);

      // If caller filters type=FACILITY -> facilities under that warehouse
      if (type === "FACILITY") {
        const facilities = await prisma.facility.findMany({
          where: { type: "FACILITY", warehouseId: wh.id },
          orderBy: [{ name: "asc" }],
        });
        return res.json(facilities);
      }

      // No type filter -> return warehouse + its facilities
      const facilities = await prisma.facility.findMany({
        where: {
          OR: [{ id: wh.id }, { warehouseId: wh.id }],
        },
        orderBy: [{ type: "asc" }, { name: "asc" }],
      });

      return res.json(facilities);
    }

    // --- FACILITY users: only their own facility
    if (!req.user.facilityId) return res.json([]);

    const fac = await prisma.facility.findUnique({ where: { id: req.user.facilityId } });
    if (!fac) return res.json([]);

    // If user asked for type and it doesn't match, return empty
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
