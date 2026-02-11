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

    // pull fresh user from DB (so disabled users are blocked)
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { facility: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "User not found or disabled" });
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      facilityId: user.facilityId,
      facility: user.facility ? { id: user.facility.id, code: user.facility.code, name: user.facility.name } : null,
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized", error: String(err.message || err) });
  }
}

module.exports = { requireAuth };
