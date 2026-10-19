// Who may administer what, and how far a user's read access reaches.
//
//  - SUPER_ADMIN: global. Every implementation (country/programme).
//  - COUNTRY_ADMIN: one implementation. Its users, supply configuration and
//    all of its data, never another country's.
//  - Country-wide VIEWER: a viewer with an implementation but no location
//    reads everything in that implementation.
//  - Everyone else is scoped by their assigned location (see dashboard
//    getScope and inventory/scope.js). A warehouse assignment reaches every
//    location below it (main warehouse -> field bases -> sites).

const prisma = require("../lib/prisma");

const isSuperAdmin = (user) => user?.role === "SUPER_ADMIN";
const isCountryAdmin = (user) => user?.role === "COUNTRY_ADMIN";
const isAdmin = (user) => isSuperAdmin(user) || isCountryAdmin(user);

/** Reads every location of one implementation (country admin, country-wide viewer). */
function countryWideImplementationId(user) {
  if (!user?.implementationId) return null;
  if (isCountryAdmin(user)) return String(user.implementationId);
  if (user.role === "VIEWER" && !user.facilityId) return String(user.implementationId);
  return null;
}

/**
 * The implementation an admin request applies to. SUPER_ADMIN may name one
 * (or none = all); a COUNTRY_ADMIN is always pinned to their own, whatever
 * they ask for.
 */
function adminImplementationId(req, requested) {
  if (isCountryAdmin(req.user)) return req.user.implementationId ? String(req.user.implementationId) : "__none__";
  const value = requested ?? req.query?.implementationId ?? null;
  return value ? String(value) : null;
}

/** May this user administer a record that belongs to `implementationId`? */
function canAdministerImplementation(user, implementationId) {
  if (isSuperAdmin(user)) return true;
  if (isCountryAdmin(user)) return !!implementationId && String(implementationId) === String(user.implementationId);
  return false;
}

/** Express guard: SUPER_ADMIN or COUNTRY_ADMIN (use after requireAuth). */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  if (!isAdmin(req.user)) return res.status(403).json({ message: "Forbidden" });
  if (isCountryAdmin(req.user) && !req.user.implementationId) {
    return res.status(403).json({ message: "Country admin account is not linked to a country" });
  }
  return next();
}

/**
 * A location and every location below it, following the stock-location
 * parent or the legacy warehouseId link. Kenya's one-level hierarchy gives the
 * same result as before (warehouse + its facilities).
 */
async function locationWithDescendants(rootId) {
  const ids = new Set([String(rootId)]);
  let frontier = [String(rootId)];
  for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
    const children = await prisma.facility.findMany({
      where: {
        OR: [{ parentStockLocationId: { in: frontier } }, { warehouseId: { in: frontier } }],
        id: { notIn: [...ids] },
      },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
    frontier.forEach((id) => ids.add(id));
  }
  return [...ids];
}

/** Client IP for audit entries (Express sets req.ip; honours a proxy if trusted). */
function clientIp(req) {
  return String(req.ip || req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").slice(0, 100) || null;
}

module.exports = {
  isSuperAdmin,
  isCountryAdmin,
  isAdmin,
  countryWideImplementationId,
  adminImplementationId,
  canAdministerImplementation,
  requireAdmin,
  locationWithDescendants,
  clientIp,
};
