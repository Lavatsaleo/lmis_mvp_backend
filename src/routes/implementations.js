const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");

// GET /api/implementations
// SUPER_ADMIN: every active implementation (to pick which country/programme to
// view or configure). Everyone else: only their own.
router.get("/", requireAuth, async (req, res) => {
  try {
    const where = { isActive: true };
    if (req.user.role !== "SUPER_ADMIN") {
      if (!req.user.implementationId) return res.json([]);
      where.id = req.user.implementationId;
    }

    const rows = await prisma.implementation.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        reportingCurrencyCode: true,
        labelGenerationScope: true,
        warehouseTools: true,
        country: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ country: { name: "asc" } }, { name: "asc" }],
    });
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// PATCH /api/implementations/:id  { labelGenerationScope?, warehouseTools? }
// Admins of that country (or Super Admin) choose where QR labels may be made
// and whether warehouse officers get the mobile stock-control tools.
const { requireAdmin, canAdministerImplementation } = require("../auth/access");
const { audit } = require("../auth/audit");
const LABEL_SCOPES = new Set(["ALL_WAREHOUSES", "MAIN_ONLY"]);

router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    if (!canAdministerImplementation(req.user, id)) return res.status(404).json({ message: "Implementation not found" });
    const data = {};
    if (req.body?.labelGenerationScope !== undefined) {
      const scope = String(req.body.labelGenerationScope || "").toUpperCase();
      if (!LABEL_SCOPES.has(scope)) return res.status(400).json({ message: "labelGenerationScope must be ALL_WAREHOUSES or MAIN_ONLY" });
      data.labelGenerationScope = scope;
    }
    if (req.body?.warehouseTools !== undefined) {
      if (typeof req.body.warehouseTools !== "boolean") return res.status(400).json({ message: "warehouseTools must be true or false" });
      data.warehouseTools = req.body.warehouseTools;
    }
    if (!Object.keys(data).length) return res.status(400).json({ message: "Nothing to change" });
    const updated = await prisma.implementation.update({
      where: { id },
      data,
      select: { id: true, name: true, labelGenerationScope: true, warehouseTools: true },
    });
    if (data.labelGenerationScope) {
      await audit(req, { action: "LABEL_POLICY_CHANGED", targetType: "IMPLEMENTATION", target: { id, name: updated.name }, implementationId: id, details: { labelGenerationScope: data.labelGenerationScope } });
    }
    if (data.warehouseTools !== undefined) {
      await audit(req, { action: "WAREHOUSE_TOOLS_CHANGED", targetType: "IMPLEMENTATION", target: { id, name: updated.name }, implementationId: id, details: { warehouseTools: data.warehouseTools } });
    }
    return res.json(updated);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
