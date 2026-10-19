const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { prisma } = require("../db");
const { signRefreshToken } = require("../utils");

// A rotated token stays valid this long. The mobile app and its background
// sync can refresh at almost the same moment with the same token; without a
// grace period the slower one would get a 401 and log the user out.
const ROTATION_GRACE_MS = 2 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

// Issue a refresh token and store its hash.
async function issueRefreshToken(userId, payload) {
  const jti = crypto.randomUUID();
  const token = signRefreshToken(payload, jti);
  const { exp } = jwt.decode(token);
  await prisma.refreshToken.create({
    data: { tokenHash: hashToken(token), userId, expiresAt: new Date(exp * 1000) },
  });
  return token;
}

/**
 * Check a verified refresh token against the store and mark it rotated.
 * Returns null if it may be exchanged, or a reason string if not.
 * Tokens issued before the store existed have no `jti` and are accepted until
 * they expire (they were never stored), so deploying this logs nobody out.
 */
async function consumeRefreshToken(token, decoded) {
  if (!decoded?.jti) return null;

  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row || row.userId !== decoded.userId) return "unknown refresh token";
  if (row.revokedAt) return "refresh token revoked";
  if (row.rotatedAt && Date.now() - row.rotatedAt.getTime() > ROTATION_GRACE_MS) {
    return "refresh token already used";
  }

  if (!row.rotatedAt) {
    await prisma.refreshToken.update({ where: { id: row.id }, data: { rotatedAt: new Date() } });
  }
  return null;
}

// Logout: revoke one token (no-op if unknown).
async function revokeRefreshToken(token) {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Deactivation / password reset: revoke every token the user holds.
async function revokeAllRefreshTokensForUser(userId, client = prisma) {
  await client.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Housekeeping: drop a user's expired tokens (called on login).
async function pruneExpiredRefreshTokens(userId) {
  await prisma.refreshToken.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } });
}

module.exports = {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  pruneExpiredRefreshTokens,
};
