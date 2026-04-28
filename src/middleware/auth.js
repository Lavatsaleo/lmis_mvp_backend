const { verifyAccessToken } = require("../utils");
const { prisma } = require("../db");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    console.log("AUTH DEBUG INCOMING", {
      method: req.method,
      path: req.originalUrl,
      hasAuthorizationHeader: !!header,
      authType: type || null,
      tokenPresent: !!token,
      tokenPreview: token ? `${token.slice(0, 12)}...${token.slice(-8)}` : null,
    });

    if (type !== "Bearer" || !token) {
      console.log("AUTH DEBUG REJECTED", {
        reason: "Missing or invalid Authorization header",
        method: req.method,
        path: req.originalUrl,
        rawAuthorizationHeader: header || null,
      });
      return res.status(401).json({ message: "Missing or invalid Authorization header" });
    }

    const decoded = verifyAccessToken(token);

    console.log("AUTH DEBUG TOKEN OK", {
      method: req.method,
      path: req.originalUrl,
      userIdFromToken: decoded.userId,
      roleFromToken: decoded.role,
      facilityIdFromToken: decoded.facilityId || null,
    });

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        facility: {
          include: {
            warehouse: true,
          },
        },
      },
    });

    if (!user || !user.isActive) {
      console.log("AUTH DEBUG REJECTED", {
        reason: "User not found or disabled",
        method: req.method,
        path: req.originalUrl,
        decodedUserId: decoded.userId,
      });
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
      facility: user.facility
        ? { id: user.facility.id, code: user.facility.code, name: user.facility.name }
        : null,
      facilityType,
      warehouseId,
      warehouse,
    };

    next();
  } catch (err) {
    console.log("AUTH DEBUG VERIFY FAILED", {
      method: req.method,
      path: req.originalUrl,
      error: String(err.message || err),
    });

    return res.status(401).json({ message: "Unauthorized", error: String(err.message || err) });
  }
}

module.exports = { requireAuth };