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
  password: z.string().min(8), // minimum 8
  role: z.enum(["SUPER_ADMIN", "WAREHOUSE_OFFICER", "FACILITY_OFFICER", "CLINICIAN", "VIEWER"]),
  facilityCode: z.string().min(1).optional(), // required for non-super admin
});

router.post("/admin/users", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }

    const { email, fullName, password, role } = parsed.data;
    const facilityCode = parsed.data.facilityCode ? String(parsed.data.facilityCode).trim() : null;

    // If not SUPER_ADMIN, facilityCode is required
    if (role !== "SUPER_ADMIN" && !facilityCode) {
      return res.status(400).json({ message: "facilityCode is required for non-SUPER_ADMIN users" });
    }

    let facilityId = null;

    // ✅ For non-super-admin roles, facility MUST already exist
    if (role !== "SUPER_ADMIN") {
      const facility = await prisma.facility.findUnique({
        where: { code: facilityCode },
      });

      if (!facility) {
        return res.status(400).json({
          message: `Facility with code "${facilityCode}" not found. Create it first using POST /api/facilities, or pick an existing one.`,
        });
      }

      // ✅ Enforce warehouse vs facility rules
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

      // ✅ Optional enforcement: facility users must belong to a warehouse
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
      data: {
        email,
        fullName,
        passwordHash,
        role,
        facilityId, // user-facility link
        isActive: true,
      },
    });

    return res.status(201).json({
      message: "User created",
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        facilityId: user.facilityId,
      },
    });
  } catch (err) {
    // ✅ handle duplicate email cleanly
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "Email already exists" });
    }

    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
