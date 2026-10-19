const prisma = require("../lib/prisma");
const { countryWideImplementationId } = require("../auth/access");

function requestedImplementationId(req) {
  if (req.user?.role === "SUPER_ADMIN" && req.query?.implementationId) {
    return String(req.query.implementationId);
  }
  return req.user?.implementationId ? String(req.user.implementationId) : null;
}

function parentIdOf(location) {
  return location.parentStockLocationId || location.warehouseId || null;
}

async function resolveLocationScope(req, { requestedLocationId = null } = {}) {
  const implementationId = requestedImplementationId(req);
  if (!implementationId) {
    return { implementationId: null, locationIds: [], locations: [] };
  }

  const locations = await prisma.facility.findMany({
    where: { implementationId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      stockLocationType: true,
      parentStockLocationId: true,
      warehouseId: true,
      capacityMetricTonnes: true,
      implementationId: true,
    },
    orderBy: [{ name: "asc" }],
  });

  const byId = new Map(locations.map((x) => [x.id, x]));

  // SUPER_ADMIN can see all locations in the selected implementation; a
  // COUNTRY_ADMIN or country-wide VIEWER all locations in their own.
  if (req.user?.role === "SUPER_ADMIN" || countryWideImplementationId(req.user)) {
    if (requestedLocationId) {
      const loc = byId.get(String(requestedLocationId));
      if (!loc) return { implementationId, locationIds: [], locations };
      return { implementationId, locationIds: [loc.id], locations };
    }
    return { implementationId, locationIds: locations.map((x) => x.id), locations };
  }

  const assignedId = req.user?.facilityId ? String(req.user.facilityId) : null;
  if (!assignedId || !byId.has(assignedId)) {
    return { implementationId, locationIds: [], locations };
  }

  const assigned = byId.get(assignedId);
  let allowed = new Set([assignedId]);

  // Warehouse users can see all descendants in the generic hierarchy. The
  // warehouseId fallback preserves the current Kenya one-level hierarchy.
  if (assigned.type === "WAREHOUSE") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const loc of locations) {
        const parentId = parentIdOf(loc);
        if (parentId && allowed.has(parentId) && !allowed.has(loc.id)) {
          allowed.add(loc.id);
          changed = true;
        }
      }
    }
  }

  if (requestedLocationId) {
    const id = String(requestedLocationId);
    return {
      implementationId,
      locationIds: allowed.has(id) ? [id] : [],
      locations,
    };
  }

  return { implementationId, locationIds: [...allowed], locations };
}

module.exports = {
  requestedImplementationId,
  resolveLocationScope,
  parentIdOf,
};
