const { verifyToken } = require("../utils");
const { prisma } = require("../db");

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing or invalid Authorization header" });
    }

    const decoded = verifyToken(token);

    // Pull fresh user from DB (so disabled users are blocked)
    // Include facility + its warehouse (does NOT break anything, just gives us more context)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        facility: {
          include: {
            warehouse: true, // works because Facility has warehouse relation now
          },
        },
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "User not found or disabled" });
    }

    // Compute warehouse scope:
    // - If user is assigned to a WAREHOUSE facility => warehouseId = that facility id
    // - If user is assigned to a FACILITY => warehouseId = facility.warehouseId
    const facilityType = user.facility ? user.facility.type : null;

    const warehouseId =
      user.facility?.type === "WAREHOUSE"
        ? user.facility.id
        : user.facility?.warehouseId || null;

    const warehouse =
      user.facility?.type === "WAREHOUSE"
        ? { id: user.facility.id, code: user.facility.code, name: user.facility.name }
        : user.facility?.warehouse
        ? { id: user.facility.warehouse.id, code: user.facility.warehouse.code, name: user.facility.warehouse.name }
        : null;

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      facilityId: user.facilityId,

      // keep existing shape (so nothing breaks)
      facility: user.facility
        ? { id: user.facility.id, code: user.facility.code, name: user.facility.name }
        : null,

      // ✅ NEW (safe additions)
      facilityType, // "WAREHOUSE" | "FACILITY" | null
      warehouseId,  // warehouse scope id or null
      warehouse,    // {id,code,name} or null
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized", error: String(err.message || err) });
  }
}

module.exports = { requireAuth };
