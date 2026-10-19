const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAdmin, isCountryAdmin, canAdministerImplementation } = require("../auth/access");
const { resolveLocationScope, requestedImplementationId, parentIdOf } = require("../inventory/scope");

const LOCATION_TYPES = new Set([
  "CENTRAL_WAREHOUSE",
  "FIELD_BASE_WAREHOUSE",
  "CLINIC_STORE",
  "PHARMACY_STORE",
  "OTHER",
]);

function normalizeLocationType(value) {
  const t = String(value || "CLINIC_STORE").trim().toUpperCase();
  return LOCATION_TYPES.has(t) ? t : null;
}

// Which location types may sit directly under which. Kenya's existing data
// (clinic stores under central warehouses) satisfies these rules.
const ALLOWED_PARENT_TYPES = {
  CENTRAL_WAREHOUSE: [], // top of the hierarchy
  FIELD_BASE_WAREHOUSE: ["CENTRAL_WAREHOUSE"],
  CLINIC_STORE: ["CENTRAL_WAREHOUSE", "FIELD_BASE_WAREHOUSE"],
  PHARMACY_STORE: ["CENTRAL_WAREHOUSE", "FIELD_BASE_WAREHOUSE"],
  OTHER: ["CENTRAL_WAREHOUSE", "FIELD_BASE_WAREHOUSE"],
};

const typeLabel = (t) => String(t || "").replaceAll("_", " ").toLowerCase();

// Error message if `parent` may not be the parent of a `childType` location.
function parentTypeError(childType, parent) {
  if (!parent) return null;
  const allowed = ALLOWED_PARENT_TYPES[childType] || [];
  if (allowed.includes(parent.stockLocationType)) return null;
  return allowed.length
    ? `A ${typeLabel(childType)} can only be placed under a ${allowed.map(typeLabel).join(" or ")}, not a ${typeLabel(parent.stockLocationType)}`
    : `A ${typeLabel(childType)} must be at the top level and cannot have a parent location`;
}

function legacyFacilityType(stockLocationType) {
  return ["CENTRAL_WAREHOUSE", "FIELD_BASE_WAREHOUSE"].includes(stockLocationType)
    ? "WAREHOUSE"
    : "FACILITY";
}

function decimalOrNull(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const e = new Error(`${fieldName} must be a non-negative number`);
    e.status = 400;
    throw e;
  }
  return n;
}


async function assertNoHierarchyCycle(locationId, proposedParentId) {
  let cursor = proposedParentId ? String(proposedParentId) : null;
  const seen = new Set();
  while (cursor) {
    if (cursor === String(locationId)) {
      const e = new Error("This parent assignment would create a stock-location hierarchy cycle");
      e.status = 400;
      throw e;
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const row = await prisma.facility.findUnique({
      where: { id: cursor },
      select: { parentStockLocationId: true, warehouseId: true },
    });
    if (!row) break;
    cursor = row.parentStockLocationId || row.warehouseId || null;
  }
}

// Decimal degrees within [min, max]; null when absent/blank.
function coordinateOrNull(value, fieldName, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    const e = new Error(`${fieldName} must be a number in decimal degrees between ${min} and ${max}`);
    e.status = 400;
    throw e;
  }
  return n;
}

// County must exist and belong to the same implementation. null clears it.
async function resolveCountyId(countyId, implementationId) {
  if (countyId === undefined) return undefined;
  if (!countyId) return null;
  const county = await prisma.county.findUnique({ where: { id: String(countyId) } });
  if (!county || county.implementationId !== implementationId) {
    const e = new Error("countyId not found for this programme");
    e.status = 400;
    throw e;
  }
  return county.id;
}

const LOCATION_INCLUDE = {
  parentStockLocation: { select: { id: true, code: true, name: true, stockLocationType: true } },
  county: { select: { id: true, name: true, state: true } },
};

function serializeLocation(loc) {
  return {
    ...loc,
    capacityMetricTonnes:
      loc.capacityMetricTonnes == null ? null : Number(loc.capacityMetricTonnes),
    latitude: loc.latitude == null ? null : Number(loc.latitude),
    longitude: loc.longitude == null ? null : Number(loc.longitude),
    lengthM: loc.lengthM == null ? null : Number(loc.lengthM),
    widthM: loc.widthM == null ? null : Number(loc.widthM),
  };
}

const STRUCTURE_TYPES = new Set(["BUILDING", "RUBB_HALL"]);

// Building type and inside size (metres) for the 3D view; null clears.
function structureFields(body) {
  const data = {};
  if (body.structureType !== undefined) {
    const t = body.structureType ? String(body.structureType).toUpperCase() : null;
    if (t && !STRUCTURE_TYPES.has(t)) {
      const e = new Error("structureType must be BUILDING or RUBB_HALL");
      e.status = 400;
      throw e;
    }
    data.structureType = t;
  }
  for (const k of ["lengthM", "widthM"]) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === "") {
      data[k] = null;
      continue;
    }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 3 || n > 500) {
      const e = new Error(`${k} must be between 3 and 500 metres`);
      e.status = 400;
      throw e;
    }
    data[k] = n;
  }
  return data;
}

function buildTree(rows) {
  const nodes = new Map(rows.map((row) => [row.id, { ...serializeLocation(row), children: [] }]));
  const roots = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    const parentId = parentIdOf(row);
    if (parentId && nodes.has(parentId)) nodes.get(parentId).children.push(node);
    else roots.push(node);
  }
  return roots;
}

// GET /api/stock-locations?tree=true&implementationId=...
router.get("/", requireAuth, async (req, res) => {
  try {
    const requestedLocationId = req.query.locationId ? String(req.query.locationId) : null;
    const scope = await resolveLocationScope(req, { requestedLocationId });
    if (!scope.implementationId) return res.json([]);

    const allowed = new Set(scope.locationIds);
    const rows = scope.locations.filter((x) => allowed.has(x.id));
    const fullRows = await prisma.facility.findMany({
      where: { id: { in: rows.map((x) => x.id) } },
      include: {
        ...LOCATION_INCLUDE,
        _count: { select: { childStockLocations: true, boxes: true } },
      },
      orderBy: [{ stockLocationType: "asc" }, { name: "asc" }],
    });

    if (String(req.query.tree || "").toLowerCase() === "true") {
      return res.json(buildTree(fullRows));
    }
    return res.json(fullRows.map(serializeLocation));
  } catch (err) {
    // Validation errors (status set, < 500) are expected; only log real failures.
    if (!err.status || err.status >= 500) console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// POST /api/stock-locations
// Body: { code, name, stockLocationType, parentStockLocationId?, capacityMetricTonnes?,
//         countyId?, latitude?, longitude?, implementationId? }
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.code || !body.name) {
      return res.status(400).json({ message: "code and name are required" });
    }

    const stockLocationType = normalizeLocationType(body.stockLocationType);
    if (!stockLocationType) {
      return res.status(400).json({ message: "Invalid stockLocationType" });
    }

    // A COUNTRY_ADMIN always configures their own implementation.
    const implementationId = isCountryAdmin(req.user)
      ? String(req.user.implementationId)
      : body.implementationId
      ? String(body.implementationId)
      : requestedImplementationId(req);
    if (!implementationId) {
      return res.status(400).json({ message: "implementationId is required" });
    }

    const implementation = await prisma.implementation.findUnique({
      where: { id: implementationId },
      select: { id: true, isActive: true },
    });
    if (!implementation || !implementation.isActive) {
      return res.status(400).json({ message: "implementationId not found or inactive" });
    }

    let parent = null;
    if (body.parentStockLocationId) {
      parent = await prisma.facility.findUnique({ where: { id: String(body.parentStockLocationId) } });
      if (!parent) return res.status(400).json({ message: "parentStockLocationId not found" });
    if (!canAdministerImplementation(req.user, parent.implementationId)) {
      return res.status(403).json({ message: "You can only configure locations in your own country." });
    }
      if (parent.implementationId !== implementationId) {
        return res.status(400).json({ message: "Parent stock location belongs to a different implementation" });
      }
      const hierarchyError = parentTypeError(stockLocationType, parent);
      if (hierarchyError) return res.status(400).json({ message: hierarchyError });
    }

    const capacityMetricTonnes = decimalOrNull(body.capacityMetricTonnes, "capacityMetricTonnes");
    const countyId = await resolveCountyId(body.countyId, implementationId);
    const latitude = coordinateOrNull(body.latitude, "latitude", -90, 90);
    const longitude = coordinateOrNull(body.longitude, "longitude", -180, 180);
    const type = legacyFacilityType(stockLocationType);

    const created = await prisma.facility.create({
      data: {
        code: String(body.code).trim(),
        name: String(body.name).trim(),
        type,
        implementationId,
        stockLocationType,
        parentStockLocationId: parent ? parent.id : null,
        capacityMetricTonnes,
        countyId: countyId ?? null,
        latitude,
        longitude,
        // Legacy Kenya/mobile compatibility for clinic/pharmacy stores.
        warehouseId: type === "FACILITY" && parent?.type === "WAREHOUSE" ? parent.id : null,
      },
      include: LOCATION_INCLUDE,
    });

    return res.status(201).json(serializeLocation(created));
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "A location with this code already exists" });
    // Validation errors (status set, < 500) are expected; only log real failures.
    if (!err.status || err.status >= 500) console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// PATCH /api/stock-locations/bulk/parent
// Body: { parentStockLocationId, locationIds: [...] }
// Link several locations (e.g. all of a county's sites) to one parent (e.g. a
// field base) in one step. Same rules as a single edit; all-or-nothing.
router.patch("/bulk/parent", requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.locationIds) ? [...new Set(body.locationIds.map(String))] : [];
    if (!body.parentStockLocationId) return res.status(400).json({ message: "parentStockLocationId is required" });
    if (!ids.length) return res.status(400).json({ message: "locationIds must be a non-empty array" });
    if (ids.length > 1000) return res.status(400).json({ message: "Link at most 1000 locations at a time" });

    const parent = await prisma.facility.findUnique({ where: { id: String(body.parentStockLocationId) } });
    if (!parent) return res.status(400).json({ message: "parentStockLocationId not found" });
    if (!canAdministerImplementation(req.user, parent.implementationId)) {
      return res.status(403).json({ message: "You can only configure locations in your own country." });
    }

    const locations = await prisma.facility.findMany({ where: { id: { in: ids } } });
    const missing = ids.filter((id) => !locations.some((l) => l.id === id));
    if (missing.length) return res.status(400).json({ message: "Some locations were not found", missing });

    const problems = [];
    for (const loc of locations) {
      if (loc.id === parent.id) {
        problems.push({ code: loc.code, message: "A location cannot be its own parent" });
        continue;
      }
      if (loc.implementationId !== parent.implementationId) {
        problems.push({ code: loc.code, message: "Belongs to a different programme than the parent" });
        continue;
      }
      const hierarchyError = parentTypeError(loc.stockLocationType, parent);
      if (hierarchyError) {
        problems.push({ code: loc.code, message: hierarchyError });
        continue;
      }
      try {
        await assertNoHierarchyCycle(loc.id, parent.id);
      } catch (e) {
        problems.push({ code: loc.code, message: e.message });
      }
    }
    if (problems.length) {
      return res.status(400).json({ message: "Some locations cannot be linked to this parent", problems: problems.slice(0, 50) });
    }

    await prisma.$transaction(
      locations.map((loc) =>
        prisma.facility.update({
          where: { id: loc.id },
          data: {
            parentStockLocationId: parent.id,
            // Legacy Kenya/mobile link used by dispatch and user rules.
            warehouseId: loc.type === "FACILITY" && parent.type === "WAREHOUSE" ? parent.id : null,
          },
        })
      )
    );

    return res.json({
      message: "Linked",
      parent: { id: parent.id, code: parent.code, name: parent.name },
      linkedCount: locations.length,
    });
  } catch (err) {
    // Validation errors (status set, < 500) are expected; only log real failures.
    if (!err.status || err.status >= 500) console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

// PATCH /api/stock-locations/:id
router.patch("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.facility.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Stock location not found" });
    if (!canAdministerImplementation(req.user, existing.implementationId)) {
      return res.status(404).json({ message: "Stock location not found" });
    }

    const body = req.body || {};
    const data = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.code !== undefined) data.code = String(body.code).trim();

    if (body.capacityMetricTonnes !== undefined) {
      data.capacityMetricTonnes = decimalOrNull(body.capacityMetricTonnes, "capacityMetricTonnes");
    }
    Object.assign(data, structureFields(body));

    const countyId = await resolveCountyId(body.countyId, existing.implementationId);
    if (countyId !== undefined) data.countyId = countyId;
    if (body.latitude !== undefined) data.latitude = coordinateOrNull(body.latitude, "latitude", -90, 90);
    if (body.longitude !== undefined) data.longitude = coordinateOrNull(body.longitude, "longitude", -180, 180);

    if (body.stockLocationType !== undefined) {
      const t = normalizeLocationType(body.stockLocationType);
      if (!t) return res.status(400).json({ message: "Invalid stockLocationType" });
      data.stockLocationType = t;
      data.type = legacyFacilityType(t);
    }

    if (body.parentStockLocationId !== undefined) {
      if (!body.parentStockLocationId) {
        data.parentStockLocationId = null;
        data.warehouseId = null;
      } else {
        const parent = await prisma.facility.findUnique({ where: { id: String(body.parentStockLocationId) } });
        if (!parent) return res.status(400).json({ message: "parentStockLocationId not found" });
        if (parent.id === existing.id) return res.status(400).json({ message: "A stock location cannot be its own parent" });
        await assertNoHierarchyCycle(existing.id, parent.id);
        if (parent.implementationId !== existing.implementationId) {
          return res.status(400).json({ message: "Parent stock location belongs to a different implementation" });
        }
        data.parentStockLocationId = parent.id;
        const effectiveType = data.type || existing.type;
        data.warehouseId = effectiveType === "FACILITY" && parent.type === "WAREHOUSE" ? parent.id : null;
      }
    }

    // ---- Hierarchy and type-change safety ----
    const effectiveLocationType = data.stockLocationType || existing.stockLocationType;
    const effectiveType = data.type || existing.type;
    const effectiveParentId =
      data.parentStockLocationId !== undefined ? data.parentStockLocationId : parentIdOf(existing);
    const effectiveParent = effectiveParentId
      ? await prisma.facility.findUnique({
          where: { id: effectiveParentId },
          select: { id: true, type: true, stockLocationType: true },
        })
      : null;

    const hierarchyError = parentTypeError(effectiveLocationType, effectiveParent);
    if (hierarchyError) return res.status(400).json({ message: hierarchyError });

    if (data.stockLocationType && data.stockLocationType !== existing.stockLocationType) {
      const children = await prisma.facility.findMany({
        where: { id: { not: id }, OR: [{ parentStockLocationId: id }, { warehouseId: id }] },
        select: { code: true, stockLocationType: true },
      });
      const invalidChildren = children.filter((c) =>
        parentTypeError(c.stockLocationType, { stockLocationType: effectiveLocationType })
      );
      if (invalidChildren.length) {
        return res.status(400).json({
          message: `Locations under this one cannot sit under a ${typeLabel(effectiveLocationType)}. Move them first.`,
          childLocations: invalidChildren.map((c) => c.code).slice(0, 25),
        });
      }

      // Switching between a warehouse type and a store type changes the legacy
      // Facility.type that dispatch, receiving and user roles depend on. Only
      // allow it while nothing depends on the location.
      if (effectiveType !== existing.type) {
        const [assignedUsers, boxesHere] = await Promise.all([
          prisma.user.count({ where: { facilityId: id } }),
          prisma.box.count({ where: { currentFacilityId: id } }),
        ]);
        if (assignedUsers || boxesHere || children.length) {
          return res.status(409).json({
            message:
              "Cannot switch between a warehouse type and a store type while users, stock or child locations are attached. Reassign or move them first.",
            assignedUsers,
            boxesHere,
            childLocations: children.length,
          });
        }
        data.warehouseId =
          effectiveType === "FACILITY" && effectiveParent?.type === "WAREHOUSE" ? effectiveParent.id : null;
      }
    }

    const updated = await prisma.facility.update({
      where: { id },
      data,
      include: LOCATION_INCLUDE,
    });
    return res.json(serializeLocation(updated));
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "A location with this code already exists" });
    // Validation errors (status set, < 500) are expected; only log real failures.
    if (!err.status || err.status >= 500) console.error(err);
    return res.status(err.status || 500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;
