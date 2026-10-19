// Donors (funding sources) per implementation.
//   GET   /api/donors?implementationId=&includeInactive=true
//   POST  /api/donors           { name, code?, implementationId? }   admins + warehouse officers
//   PATCH /api/donors/:id       { name?, code?, isActive? }           admins
// Names are unique per implementation, ignoring case: creating "unicef" when
// "UNICEF" exists returns the existing donor instead of a duplicate.

const express = require("express");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");
const { requireAdmin, isSuperAdmin, isCountryAdmin, canAdministerImplementation } = require("../auth/access");
const { audit } = require("../auth/audit");

const router = express.Router();

const clean = (v) => {
  const s = v == null ? "" : String(v).trim().replace(/\s+/g, " ");
  return s || null;
};

function implementationFor(req, requested) {
  if (isSuperAdmin(req.user)) return requested ? String(requested) : req.user.implementationId || null;
  return req.user.implementationId || null;
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const implementationId = implementationFor(req, req.query.implementationId);
    if (!implementationId) return res.json([]);
    const where = { implementationId };
    if (req.query.includeInactive !== "true") where.isActive = true;
    const rows = await prisma.donor.findMany({
      where,
      orderBy: { name: "asc" },
      include: { _count: { select: { boxes: true, purchaseOrderLines: true } } },
    });
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.post("/", requireAuth, requireRole("SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER"), async (req, res) => {
  try {
    const name = clean(req.body?.name);
    if (!name || name.length < 2) return res.status(400).json({ message: "Donor name is required" });
    const implementationId = implementationFor(req, req.body?.implementationId);
    if (!implementationId) return res.status(400).json({ message: "implementationId is required" });

    // Case-insensitive match (the column collation is case-insensitive too).
    const existing = await prisma.donor.findFirst({ where: { implementationId, name } });
    if (existing) {
      if (!existing.isActive && (isSuperAdmin(req.user) || isCountryAdmin(req.user))) {
        const revived = await prisma.donor.update({ where: { id: existing.id }, data: { isActive: true } });
        return res.json({ ...revived, existed: true });
      }
      return res.json({ ...existing, existed: true });
    }

    const donor = await prisma.donor.create({ data: { implementationId, name, code: clean(req.body?.code) } });
    await audit(req, { action: "DONOR_CREATED", targetType: "DONOR", target: { id: donor.id, name: donor.name }, implementationId });
    return res.status(201).json(donor);
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "A donor with this name already exists" });
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const donor = await prisma.donor.findUnique({ where: { id: String(req.params.id) } });
    if (!donor || !canAdministerImplementation(req.user, donor.implementationId)) {
      return res.status(404).json({ message: "Donor not found" });
    }
    const data = {};
    if (req.body?.name !== undefined) {
      const name = clean(req.body.name);
      if (!name || name.length < 2) return res.status(400).json({ message: "Donor name cannot be empty" });
      data.name = name;
    }
    if (req.body?.code !== undefined) data.code = clean(req.body.code);
    if (typeof req.body?.isActive === "boolean") data.isActive = req.body.isActive;
    const updated = await prisma.donor.update({ where: { id: donor.id }, data });
    await audit(req, {
      action: "DONOR_UPDATED",
      targetType: "DONOR",
      target: { id: donor.id, name: updated.name },
      implementationId: donor.implementationId,
      details: data,
    });
    return res.json(updated);
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "A donor with this name already exists" });
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
