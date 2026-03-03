const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");

// ✅ Use the same prisma you use elsewhere
const prisma = require("../lib/prisma");

const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

const router = express.Router();

// ✅ Logged-in user info
router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

// ✅ SUPER_ADMIN creates new users
const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  password: z.string().min(8),
  role: z.enum(["SUPER_ADMIN", "WAREHOUSE_OFFICER", "FACILITY_OFFICER", "CLINICIAN", "VIEWER"]),
  facilityCode: z.string().min(1).optional(),
});

router.post("/admin/users", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }

    const { email, fullName, password, role } = parsed.data;
    const facilityCode = parsed.data.facilityCode ? String(parsed.data.facilityCode).trim() : null;

    // VIEWER allowed to be global (no facility)
    if (role !== "SUPER_ADMIN" && role !== "VIEWER" && !facilityCode) {
      return res.status(400).json({ message: "facilityCode is required for this role" });
    }

    let facilityId = null;

    if (role !== "SUPER_ADMIN" && role !== "VIEWER") {
      const facility = await prisma.facility.findUnique({ where: { code: facilityCode } });
      if (!facility) {
        return res.status(400).json({
          message: `Facility with code "${facilityCode}" not found. Create it first using POST /api/facilities, or pick an existing one.`,
        });
      }

      if (role === "WAREHOUSE_OFFICER" && facility.type !== "WAREHOUSE") {
        return res.status(400).json({
          message: `WAREHOUSE_OFFICER must be assigned to a WAREHOUSE facility. "${facilityCode}" is type "${facility.type}".`,
        });
      }

      if (role !== "WAREHOUSE_OFFICER" && facility.type !== "FACILITY") {
        return res.status(400).json({
          message: `${role} must be assigned to a FACILITY (not a warehouse). "${facilityCode}" is type "${facility.type}".`,
        });
      }

      if (role !== "WAREHOUSE_OFFICER" && role !== "SUPER_ADMIN") {
        if (!facility.warehouseId) {
          return res.status(400).json({
            message: `Facility "${facility.code}" is not linked to a warehouse yet (warehouseId is null). Link it first.`,
          });
        }
      }

      facilityId = facility.id;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { email, fullName, passwordHash, role, facilityId, isActive: true },
    });

    return res.status(201).json({
      message: "User created",
      user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role, facilityId: user.facilityId },
    });
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "Email already exists" });
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ✅ List users
router.get("/admin/users", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, Number.parseInt(req.query.take || "50", 10)));
    const skip = Math.max(0, Number.parseInt(req.query.skip || "0", 10));

    const q = req.query.q ? String(req.query.q).trim() : null;
    const role = req.query.role ? String(req.query.role).trim() : null;
    const facilityCode = req.query.facilityCode ? String(req.query.facilityCode).trim() : null;

    let isActive = null;
    if (req.query.isActive === "true") isActive = true;
    if (req.query.isActive === "false") isActive = false;

    let facilityId = null;
    if (facilityCode) {
      const f = await prisma.facility.findUnique({ where: { code: facilityCode }, select: { id: true } });
      if (!f) return res.status(400).json({ message: `Facility with code "${facilityCode}" not found.` });
      facilityId = f.id;
    }

    const where = {};
    if (q) where.OR = [{ email: { contains: q } }, { fullName: { contains: q } }];
    if (role) where.role = role;
    if (isActive !== null) where.isActive = isActive;
    if (facilityId) where.facilityId = facilityId;

    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: [{ isActive: "desc" }, { role: "asc" }, { fullName: "asc" }],
        take,
        skip,
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
          facilityId: true,
          facility: { select: { id: true, code: true, name: true, type: true } },
          createdAt: true,
        },
      }),
    ]);

    return res.json({ total, take, skip, rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// ✅ Enable/disable + optional password reset
const updateUserSchema = z.object({
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
});

router.patch("/admin/users/:userId", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });

    const userId = String(req.params.userId);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const data = {};
    if (typeof parsed.data.isActive === "boolean") data.isActive = parsed.data.isActive;
    if (parsed.data.password) data.passwordHash = await bcrypt.hash(parsed.data.password, 10);

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        facilityId: true,
        facility: { select: { id: true, code: true, name: true, type: true } },
      },
    });

    return res.json({ message: "User updated", user: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;