const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin, isCountryAdmin, canAdministerImplementation } = require("../auth/access");
const { requestedImplementationId } = require("../inventory/scope");

// Counties are configurable administrative areas per implementation. Field
// bases and sites are grouped by county; a site is linked to one of its
// county's field bases.

function cleanText(value) {
  const s = value == null ? "" : String(value).trim();
  return s || null;
}

function serialize(county) {
  const { _count, ...rest } = county;
  return { ...rest, locationCount: _count?.locations ?? undefined };
}

// GET /api/counties?implementationId=...&includeInactive=true
router.get("/", requireAuth, async (req, res) => {
  try {
    const implementationId = requestedImplementationId(req);
    if (!implementationId) return res.json([]);

    const rows = await prisma.county.findMany({
      where: {
        implementationId,
        ...(String(req.query.includeInactive || "").toLowerCase() === "true" ? {} : { isActive: true }),
      },
      include: { _count: { select: { locations: true } } },
      orderBy: [{ state: "asc" }, { name: "asc" }],
    });
    return res.json(rows.map(serialize));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// POST /api/counties  Body: { name, state?, implementationId? }
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = cleanText(body.name);
    if (!name) return res.status(400).json({ message: "name is required" });

    // A COUNTRY_ADMIN always configures their own implementation.
    const implementationId = isCountryAdmin(req.user)
      ? String(req.user.implementationId)
      : body.implementationId
      ? String(body.implementationId)
      : requestedImplementationId(req);
    if (!implementationId) return res.status(400).json({ message: "implementationId is required" });

    const implementation = await prisma.implementation.findUnique({
      where: { id: implementationId },
      select: { id: true, isActive: true },
    });
    if (!implementation || !implementation.isActive) {
      return res.status(400).json({ message: "implementationId not found or inactive" });
    }

    const created = await prisma.county.create({
      data: { implementationId, name, state: cleanText(body.state) },
    });
    return res.status(201).json(serialize(created));
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "A county with this name already exists for this programme" });
    }
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// PATCH /api/counties/:id  Body: { name?, state?, isActive? }
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const existing = await prisma.county.findUnique({ where: { id: String(req.params.id) } });
    if (!existing || !canAdministerImplementation(req.user, existing.implementationId)) {
      return res.status(404).json({ message: "County not found" });
    }

    const body = req.body || {};
    const data = {};
    if (body.name !== undefined) {
      const name = cleanText(body.name);
      if (!name) return res.status(400).json({ message: "name cannot be empty" });
      data.name = name;
    }
    if (body.state !== undefined) data.state = cleanText(body.state);
    if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === "true";

    const updated = await prisma.county.update({ where: { id: existing.id }, data });
    return res.json(serialize(updated));
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ message: "A county with this name already exists for this programme" });
    }
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
