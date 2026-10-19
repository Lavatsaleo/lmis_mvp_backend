const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { revokeAllRefreshTokensForUser } = require("../auth/refreshTokens");
const { isCountryAdmin, requireAdmin, canAdministerImplementation } = require("../auth/access");
const { audit } = require("../auth/audit");

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});

const ROLE_VALUES = ["SUPER_ADMIN", "COUNTRY_ADMIN", "WAREHOUSE_OFFICER", "FACILITY_OFFICER", "CLINICIAN", "VIEWER"];
// Only a SUPER_ADMIN may create, edit or grant these.
const ADMIN_ROLES = new Set(["SUPER_ADMIN", "COUNTRY_ADMIN"]);

const createUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  password: z.string().min(8),
  role: z.enum(ROLE_VALUES),
  facilityCode: z.string().min(1).optional(),
  implementationId: z.string().min(1).optional(),
  // Default true: the user picks their own password at first sign-in.
  requirePasswordChange: z.boolean().optional(),
});

async function activeImplementation(implementationId) {
  if (!implementationId) return null;
  return prisma.implementation.findFirst({ where: { id: implementationId, isActive: true }, select: { id: true } });
}

// Resolve and validate where a user is assigned.
//  - SUPER_ADMIN: no assignment; sees everything.
//  - COUNTRY_ADMIN: no location; one implementation (required).
//  - VIEWER: a WAREHOUSE (sees it and everything below it), a FACILITY (only
//    it), or no location + an implementation (the whole country, read-only).
//  - WAREHOUSE_OFFICER: a WAREHOUSE.
//  - CLINICIAN / FACILITY_OFFICER: a FACILITY linked to a warehouse.
// Returns { facilityId, implementationId } or { error: { status, message } }.
async function resolveUserAssignment({ role, facilityCode, implementationId }) {
  if (role === "SUPER_ADMIN") {
    return { facilityId: null, implementationId: implementationId || null };
  }

  if (role === "COUNTRY_ADMIN" || (role === "VIEWER" && !facilityCode)) {
    if (role === "COUNTRY_ADMIN" && facilityCode) {
      return { error: { status: 400, message: "COUNTRY_ADMIN covers a whole country and is not assigned to a location" } };
    }
    if (!(await activeImplementation(implementationId))) {
      return {
        error: {
          status: 400,
          message:
            role === "VIEWER"
              ? "VIEWER needs a warehouse, a facility, or a country (implementationId) for country-wide read access"
              : "COUNTRY_ADMIN needs a country (implementationId)",
        },
      };
    }
    return { facilityId: null, implementationId };
  }

  if (!facilityCode) {
    return { error: { status: 400, message: "facilityCode is required for this role" } };
  }

  const facility = await prisma.facility.findUnique({ where: { code: facilityCode } });
  if (!facility) {
    return {
      error: {
        status: 400,
        message: `Facility with code "${facilityCode}" not found. Create it first using POST /api/facilities, or pick an existing one.`,
      },
    };
  }

  if (role === "WAREHOUSE_OFFICER" && facility.type !== "WAREHOUSE") {
    return {
      error: {
        status: 400,
        message: `WAREHOUSE_OFFICER must be assigned to a WAREHOUSE facility. "${facilityCode}" is type "${facility.type}".`,
      },
    };
  }

  if ((role === "CLINICIAN" || role === "FACILITY_OFFICER") && facility.type !== "FACILITY") {
    return {
      error: {
        status: 400,
        message: `${role} must be assigned to a FACILITY (not a warehouse). "${facilityCode}" is type "${facility.type}".`,
      },
    };
  }

  if ((role === "CLINICIAN" || role === "FACILITY_OFFICER") && !facility.warehouseId) {
    return {
      error: {
        status: 400,
        message: `Facility "${facility.code}" is not linked to a warehouse yet (warehouseId is null). Link it first.`,
      },
    };
  }

  if (implementationId && facility.implementationId && implementationId !== facility.implementationId) {
    return { error: { status: 400, message: "User and facility must belong to the same implementation" } };
  }

  return { facilityId: facility.id, implementationId: facility.implementationId || implementationId || null };
}

// Which modules a role needs in its implementation. South Sudan runs clinical
// tracking in DHIS2 (LOGISTICS only), so it cannot have LMIS clinicians.
const ROLE_MODULES = {
  WAREHOUSE_OFFICER: ["LOGISTICS"],
  FACILITY_OFFICER: ["LOGISTICS", "CLINICAL"],
  CLINICIAN: ["CLINICAL"],
};

async function roleModuleError(role, implementationId) {
  const needed = ROLE_MODULES[role];
  if (!needed || !implementationId) return null;

  const implementation = await prisma.implementation.findUnique({
    where: { id: implementationId },
    select: {
      name: true,
      country: { select: { name: true } },
      modules: { where: { isEnabled: true }, select: { module: true } },
    },
  });
  if (!implementation) return null;

  const enabled = new Set(implementation.modules.map((m) => m.module));
  if (needed.some((m) => enabled.has(m))) return null;

  const where = implementation.country?.name || implementation.name;
  return `${role} is not available in ${where}: it needs the ${needed.join(" or ")} module, which is not enabled there.`;
}

async function countOtherActiveSuperAdmins(userId) {
  return prisma.user.count({ where: { role: "SUPER_ADMIN", isActive: true, id: { not: userId } } });
}

// What a COUNTRY_ADMIN may not do: touch admin accounts, grant admin roles, or
// reach outside their own country. Returns an error message or null.
function countryAdminLimit(req, { targetRole = null, grantRole = null, implementationId = undefined }) {
  if (!isCountryAdmin(req.user)) return null;
  if (targetRole && ADMIN_ROLES.has(targetRole)) return "Only a Super Admin can manage admin accounts.";
  if (grantRole && ADMIN_ROLES.has(grantRole)) return "Only a Super Admin can grant admin roles.";
  if (implementationId !== undefined && !canAdministerImplementation(req.user, implementationId)) {
    return "You can only manage users in your own country.";
  }
  return null;
}

router.post("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    }

    const { email, fullName, password, role } = parsed.data;
    const facilityCode = parsed.data.facilityCode ? String(parsed.data.facilityCode).trim() : null;

    const roleLimit = countryAdminLimit(req, { grantRole: role });
    if (roleLimit) return res.status(403).json({ message: roleLimit });

    // The assigned location decides the user's country/programme. Only an
    // explicit implementationId is checked against it; the admin's own
    // implementation is just the fallback for unlinked locations, otherwise a
    // Kenya-based admin could not create South Sudan users. A COUNTRY_ADMIN
    // always creates users in their own country.
    const requestedImplementationId = isCountryAdmin(req.user)
      ? String(req.user.implementationId)
      : parsed.data.implementationId
      ? String(parsed.data.implementationId)
      : null;
    const assignment = await resolveUserAssignment({ role, facilityCode, implementationId: requestedImplementationId });
    if (assignment.error) {
      return res.status(assignment.error.status).json({ message: assignment.error.message });
    }
    const { facilityId } = assignment;
    const implementationId = assignment.implementationId || req.user.implementationId || null;

    const scopeLimit = countryAdminLimit(req, { implementationId });
    if (scopeLimit) return res.status(403).json({ message: scopeLimit });

    const moduleError = await roleModuleError(role, implementationId);
    if (moduleError) return res.status(400).json({ code: "ROLE_NOT_AVAILABLE", message: moduleError });

    if (implementationId && !(await activeImplementation(implementationId))) {
      return res.status(400).json({ message: "implementationId not found or inactive" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const mustChangePassword = parsed.data.requirePasswordChange !== false;

    const user = await prisma.user.create({
      data: { email, fullName, passwordHash, role, facilityId, implementationId, isActive: true, mustChangePassword },
    });

    await audit(req, {
      action: "USER_CREATED",
      target: user,
      details: { role, facilityCode, mustChangePassword },
    });

    return res.status(201).json({
      message: "User created",
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        facilityId: user.facilityId,
        implementationId: user.implementationId,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt,
      },
    });
  } catch (err) {
    if (err?.code === "P2002") return res.status(409).json({ message: "Email already exists" });
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, Number.parseInt(req.query.take || "50", 10)));
    const skip = Math.max(0, Number.parseInt(req.query.skip || "0", 10));

    const q = req.query.q ? String(req.query.q).trim() : null;
    const role = req.query.role ? String(req.query.role).trim() : null;
    const facilityCode = req.query.facilityCode ? String(req.query.facilityCode).trim() : null;
    // A country/programme, or "none" for accounts with no implementation (global
    // admins). A COUNTRY_ADMIN only ever sees their own country.
    const implementationId = isCountryAdmin(req.user)
      ? String(req.user.implementationId)
      : req.query.implementationId
      ? String(req.query.implementationId).trim()
      : null;

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
    if (implementationId === "none") where.implementationId = null;
    else if (implementationId) where.implementationId = implementationId;
    if (req.query.locked === "true") where.lockedUntil = { gt: new Date() };

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
          implementationId: true,
          implementation: {
            select: {
              id: true,
              code: true,
              name: true,
              country: { select: { id: true, code: true, name: true } },
            },
          },
          facility: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true,
              stockLocationType: true,
              county: { select: { id: true, name: true } },
            },
          },
          mustChangePassword: true,
          failedLoginCount: true,
          lockedUntil: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
    ]);

    const now = Date.now();
    return res.json({
      total,
      take,
      skip,
      rows: rows.map((u) => ({ ...u, isLocked: !!u.lockedUntil && u.lockedUntil.getTime() > now })),
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});


const updateUserSchema = z.object({
  isActive: z.boolean().optional(),
  password: z.string().min(8).optional(),
  // With a password reset: make the user choose a new one (default true).
  requirePasswordChange: z.boolean().optional(),
  fullName: z.string().trim().min(2).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  // Reassign the user to a warehouse/facility (same rules as creation).
  facilityCode: z.string().min(1).optional(),
  // Country for location-less roles (COUNTRY_ADMIN, country-wide VIEWER).
  implementationId: z.string().min(1).optional(),
  // VIEWER: drop the location and read the whole country instead.
  countryWide: z.boolean().optional(),
  // Clear a sign-in lock caused by repeated wrong passwords.
  unlock: z.boolean().optional(),
});

const USER_DETAIL_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  facilityId: true,
  implementationId: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  facility: { select: { id: true, code: true, name: true, type: true } },
};

router.patch("/admin/users/:userId", requireAuth, requireAdmin, async (req, res) => {
  try {
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });
    const body = parsed.data;

    const userId = String(req.params.userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { facility: { select: { code: true } } },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    const isSelf = userId === req.user.id;
    const nextRole = body.role || user.role;
    const roleChanged = nextRole !== user.role;

    // A country admin only manages non-admin users of their own country (and
    // a user they cannot see is reported as not found).
    if (isCountryAdmin(req.user) && !canAdministerImplementation(req.user, user.implementationId)) {
      return res.status(404).json({ message: "User not found" });
    }
    const limit = countryAdminLimit(req, {
      targetRole: isSelf ? null : user.role,
      grantRole: roleChanged ? nextRole : null,
    });
    if (limit) return res.status(403).json({ message: limit });

    // Guard rails: an admin cannot lock themselves out, and the system always
    // keeps at least one active SUPER_ADMIN.
    if (isSelf && body.isActive === false) {
      return res.status(400).json({ code: "SELF_LOCKOUT", message: "You cannot disable your own account." });
    }
    if (isSelf && (roleChanged || body.facilityCode || body.implementationId || body.countryWide)) {
      return res.status(400).json({ code: "SELF_LOCKOUT", message: "You cannot change your own role or assignment." });
    }
    const losesSuperAdmin = user.role === "SUPER_ADMIN" && user.isActive && (roleChanged || body.isActive === false);
    if (losesSuperAdmin && (await countOtherActiveSuperAdmins(userId)) === 0) {
      return res.status(400).json({
        code: "LAST_SUPER_ADMIN",
        message: "This is the only active Super Admin. Create or enable another Super Admin first.",
      });
    }

    const data = {};
    if (typeof body.isActive === "boolean" && body.isActive !== user.isActive) data.isActive = body.isActive;
    if (body.password) {
      data.passwordHash = await bcrypt.hash(body.password, 10);
      data.mustChangePassword = body.requirePasswordChange !== false;
      // A fresh password from an admin also clears any lock.
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    }
    if (body.unlock) {
      data.failedLoginCount = 0;
      data.lockedUntil = null;
    }
    if (body.fullName && body.fullName !== user.fullName) data.fullName = body.fullName;

    // A role change re-checks the assignment against the new role (keeping the
    // current location unless a new one is given); a move re-checks it too.
    const assignmentTouched =
      roleChanged ||
      !!body.facilityCode ||
      !!body.countryWide ||
      (!!body.implementationId && body.implementationId !== user.implementationId);
    if (assignmentTouched) {
      if (nextRole === "SUPER_ADMIN") {
        if (body.facilityCode) {
          return res.status(400).json({ message: "SUPER_ADMIN is not assigned to a warehouse or facility" });
        }
        data.facilityId = null;
      } else {
        const locationLess = nextRole === "COUNTRY_ADMIN" || (nextRole === "VIEWER" && !!body.countryWide);
        const facilityCode = locationLess
          ? null
          : body.facilityCode
          ? String(body.facilityCode).trim()
          : user.facility?.code || null;
        const requestedImplementationId = isCountryAdmin(req.user)
          ? String(req.user.implementationId)
          : body.implementationId || (locationLess ? user.implementationId : null);
        const assignment = await resolveUserAssignment({
          role: nextRole,
          facilityCode,
          implementationId: requestedImplementationId || null,
        });
        if (assignment.error) {
          return res.status(assignment.error.status).json({ message: assignment.error.message });
        }
        const implementationId = assignment.implementationId || user.implementationId || null;
        const scopeLimit = countryAdminLimit(req, { implementationId });
        if (scopeLimit) return res.status(403).json({ message: scopeLimit });
        const moduleError = await roleModuleError(nextRole, implementationId);
        if (moduleError) return res.status(400).json({ code: "ROLE_NOT_AVAILABLE", message: moduleError });

        data.facilityId = assignment.facilityId;
        data.implementationId = implementationId;
      }
      if (roleChanged) data.role = nextRole;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    // A deactivated user, one whose password was reset, or one whose role,
    // location or country changed must sign in again everywhere: retire their
    // refresh tokens so the apps pick up the new permissions.
    const locationChanged = "facilityId" in data && data.facilityId !== user.facilityId;
    const countryChanged = "implementationId" in data && data.implementationId !== user.implementationId;
    if (data.isActive === false || data.passwordHash || roleChanged || locationChanged || countryChanged) {
      await revokeAllRefreshTokensForUser(userId);
    }

    const updated = await prisma.user.update({ where: { id: userId }, data, select: USER_DETAIL_SELECT });

    // One audit entry per kind of change, so the log reads naturally.
    if ("isActive" in data) {
      await audit(req, { action: data.isActive ? "USER_ENABLED" : "USER_DISABLED", target: updated });
    }
    if (data.passwordHash) {
      await audit(req, {
        action: "PASSWORD_RESET",
        target: updated,
        details: { mustChangePassword: data.mustChangePassword },
      });
    }
    if (body.unlock && !data.passwordHash) {
      await audit(req, { action: "USER_UNLOCKED", target: updated });
    }
    const changes = {};
    if (roleChanged) changes.role = { from: user.role, to: nextRole };
    if (locationChanged) changes.facility = { from: user.facility?.code || null, to: updated.facility?.code || null };
    if (countryChanged) changes.implementationId = { from: user.implementationId, to: data.implementationId };
    if (data.fullName) changes.fullName = { from: user.fullName, to: data.fullName };
    if (Object.keys(changes).length) {
      await audit(req, { action: roleChanged ? "ROLE_CHANGED" : "USER_UPDATED", target: updated, details: changes });
    }

    return res.json({ message: "User updated", user: updated });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// GET /api/admin/users/summary
// Head counts per country/programme and role, for the Users page tiles.
// A COUNTRY_ADMIN gets only their own country.
router.get("/admin/users/summary", requireAuth, requireAdmin, async (req, res) => {
  try {
    const own = isCountryAdmin(req.user) ? String(req.user.implementationId) : null;
    const [groups, implementations] = await Promise.all([
      prisma.user.groupBy({
        by: ["implementationId", "role", "isActive"],
        where: own ? { implementationId: own } : undefined,
        _count: { _all: true },
      }),
      prisma.implementation.findMany({
        where: own ? { id: own } : undefined,
        select: {
          id: true,
          code: true,
          name: true,
          country: { select: { id: true, code: true, name: true } },
          modules: { where: { isEnabled: true }, select: { module: true } },
        },
        orderBy: [{ country: { name: "asc" } }, { name: "asc" }],
      }),
    ]);

    const buckets = new Map();
    const bucketFor = (id) => {
      const key = id || "none";
      if (!buckets.has(key)) buckets.set(key, { total: 0, active: 0, byRole: {} });
      return buckets.get(key);
    };
    for (const g of groups) {
      const b = bucketFor(g.implementationId);
      const n = g._count._all;
      b.total += n;
      if (g.isActive) b.active += n;
      b.byRole[g.role] = (b.byRole[g.role] || 0) + n;
    }

    const rows = implementations.map((impl) => ({
      implementation: {
        id: impl.id,
        code: impl.code,
        name: impl.name,
        country: impl.country,
        enabledModules: impl.modules.map((m) => m.module),
      },
      ...bucketFor(impl.id),
    }));
    if (!own && buckets.has("none")) rows.push({ implementation: null, ...buckets.get("none") });

    return res.json({ rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

// GET /api/admin/audit-logs
// Account and sign-in audit trail. Filters: action, actorId, targetId, q
// (email), from/to (ISO dates), implementationId (SUPER_ADMIN), take/skip.
// A COUNTRY_ADMIN sees only their own country's entries.
router.get("/admin/audit-logs", requireAuth, requireAdmin, async (req, res) => {
  try {
    const take = Math.min(200, Math.max(1, Number.parseInt(req.query.take || "50", 10) || 50));
    const skip = Math.max(0, Number.parseInt(req.query.skip || "0", 10) || 0);

    const where = {};
    if (isCountryAdmin(req.user)) where.implementationId = String(req.user.implementationId);
    else if (req.query.implementationId) where.implementationId = String(req.query.implementationId);
    if (req.query.action) where.action = String(req.query.action);
    if (req.query.actorId) where.actorId = String(req.query.actorId);
    if (req.query.targetId) where.targetId = String(req.query.targetId);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      where.OR = [{ actorEmail: { contains: q } }, { targetLabel: { contains: q } }];
    }
    const validDate = (v) => {
      if (!v) return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const from = validDate(req.query.from);
    const to = validDate(req.query.to);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        skip,
        include: { actor: { select: { id: true, fullName: true, email: true, role: true } } },
      }),
    ]);
    return res.json({ total, take, skip, rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

module.exports = router;
