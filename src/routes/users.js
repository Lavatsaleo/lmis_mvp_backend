const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

const router = express.Router();

// ✅ Logged-in user info (test endpoint)
router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

// ✅ SUPER_ADMIN creates new users
const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  password: z.string().min(6),
  role: z.enum(["SUPER_ADMIN", "WAREHOUSE_OFFICER", "FACILITY_OFFICER", "CLINICIAN", "VIEWER"]),
  facilityCode: z.string().min(1).optional(),
  facilityName: z.string().min(1).optional(),
});

router.post("/admin/users", requireAuth, requireRole("SUPER_ADMIN"), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
  }

  const { email, fullName, password, role, facilityCode, facilityName } = parsed.data;

  // If not SUPER_ADMIN, facilityCode is required
  if (role !== "SUPER_ADMIN" && !facilityCode) {
    return res.status(400).json({ message: "facilityCode is required for non-SUPER_ADMIN users" });
  }

  // Create or find facility (if provided)
  let facilityId = null;
  if (facilityCode) {
    const facility = await prisma.facility.upsert({
      where: { code: facilityCode },
      update: { name: facilityName || facilityCode },
      create: { code: facilityCode, name: facilityName || facilityCode },
    });
    facilityId = facility.id;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      email,
      fullName,
      passwordHash,
      role,
      facilityId,
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
});

module.exports = router;
