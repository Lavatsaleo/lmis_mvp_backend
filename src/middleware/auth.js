const { verifyAccessToken } = require("../utils");
const { prisma } = require("../db");
const { implementationInclude, buildPlatformContext } = require("../platform/context");

// While a user must change their password, only these work (so the apps can
// show who is signed in, change it, or sign out).
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/me", "/api/auth/change-password", "/api/auth/logout"]);

async function requireAuth(req, res, next) {
  // Already authenticated earlier in this request (e.g. a router-level guard
  // ran before the route's own requireAuth): don't look the user up twice.
  if (req.user) return next();

  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing or invalid Authorization header" });
    }

    const decoded = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        facility: {
          include: {
            warehouse: true,
          },
        },
        implementation: {
          include: implementationInclude,
        },
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "User not found or disabled" });
    }

    const facilityType = user.facility ? user.facility.type : null;

    const warehouseId =
      user.facility?.type === "WAREHOUSE"
        ? user.facility.id
        : user.facility?.warehouseId || null;

    const warehouse =
      user.facility?.type === "WAREHOUSE"
        ? { id: user.facility.id, code: user.facility.code, name: user.facility.name }
        : user.facility?.warehouse
        ? {
            id: user.facility.warehouse.id,
            code: user.facility.warehouse.code,
            name: user.facility.warehouse.name,
          }
        : null;

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      facilityId: user.facilityId,
      implementationId: user.implementationId || null,
      platformContext: buildPlatformContext(user),
      facility: user.facility
        ? {
            id: user.facility.id,
            code: user.facility.code,
            name: user.facility.name,
            // Lets the apps tell a field base (receives transfers) from a main warehouse.
            stockLocationType: user.facility.stockLocationType,
            parentStockLocationId: user.facility.parentStockLocationId || null,
          }
        : null,
      facilityType,
      warehouseId,
      warehouse,
      mustChangePassword: !!user.mustChangePassword,
    };

    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.originalUrl.split("?")[0])) {
      return res.status(403).json({
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "You must change your password before continuing.",
      });
    }

    next();
  } catch (err) {
    console.warn("AUTH VERIFY FAILED", {
      method: req.method,
      path: req.originalUrl,
      error: String(err.message || err),
    });

    return res.status(401).json({ message: "Unauthorized", error: String(err.message || err) });
  }
}

module.exports = { requireAuth };