const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");
const {
  signAccessToken,
  verifyRefreshToken,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
} = require("../utils");
const { implementationInclude, buildPlatformContext } = require("../platform/context");
const {
  issueRefreshToken,
  consumeRefreshToken,
  revokeRefreshToken,
  pruneExpiredRefreshTokens,
  revokeAllRefreshTokensForUser,
} = require("../auth/refreshTokens");
const { requireAuth } = require("../middleware/auth");
const { loginPerAccountLimiter, loginPerIpLimiter } = require("../middleware/rateLimit");
const { audit } = require("../auth/audit");

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function buildUserPayload(user) {
  return {
    userId: user.id,
    role: user.role,
    facilityId: user.facilityId || null,
    implementationId: user.implementationId || null,
  };
}

function buildUserResponse(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    facilityId: user.facilityId,
    implementationId: user.implementationId || null,
    // The apps send the user to a change-password screen first when true.
    mustChangePassword: !!user.mustChangePassword,
    platformContext: buildPlatformContext(user),
    facility: user.facility
      ? {
          id: user.facility.id,
          code: user.facility.code,
          name: user.facility.name,
          // Same shape as /api/me: lets the apps recognise a field base.
          stockLocationType: user.facility.stockLocationType,
          parentStockLocationId: user.facility.parentStockLocationId || null,
        }
      : null,
  };
}

// Account lockout: this many wrong passwords in a row locks sign-in for
// LOCK_MINUTES. An admin can unlock early (or reset the password).
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
// Compared against when the email is unknown, so the response time does not
// reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function lockedResponse(res, lockedUntil) {
  const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(423).json({
    code: "ACCOUNT_LOCKED",
    message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or ask an admin to unlock your account.`,
    retryAfterSeconds,
    lockedUntil,
  });
}

router.post("/login", loginPerIpLimiter, loginPerAccountLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Invalid input",
      errors: parsed.error.flatten(),
    });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      facility: true,
      implementation: { include: implementationInclude },
    },
  });

  if (!user || !user.isActive) {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(401).json({ message: "Invalid credentials" });
  }

  // While locked the password is not even checked, so guessing cannot go on.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    return lockedResponse(res, user.lockedUntil);
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const after = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (after.failedLoginCount >= MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      await prisma.user.update({ where: { id: user.id }, data: { lockedUntil, failedLoginCount: 0 } });
      await audit(req, {
        action: "ACCOUNT_LOCKED",
        actor: user,
        target: user,
        details: { failedAttempts: after.failedLoginCount, lockedMinutes: LOCK_MINUTES },
      });
      return lockedResponse(res, lockedUntil);
    }
    await audit(req, {
      action: "LOGIN_FAILED",
      actor: user,
      target: user,
      details: { failedAttempts: after.failedLoginCount },
    });
    return res.status(401).json({ message: "Invalid credentials" });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

  return res.json(await issueSession(user));
});

// Tokens + user payload for a signed-in user (login and password change).
async function issueSession(user) {
  const payload = buildUserPayload(user);

  const accessToken = signAccessToken(payload);
  const token = accessToken;
  await pruneExpiredRefreshTokens(user.id);
  const refreshToken = await issueRefreshToken(user.id, payload);

  return {
    token,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    refreshExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
    user: buildUserResponse(user),
  };
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
});

// POST /api/auth/change-password  Body: { currentPassword, newPassword }
// The signed-in user sets their own password (required after an admin created
// the account or reset it). Every other session is signed out; the response
// carries fresh tokens for this one.
router.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message;
    return res.status(400).json({ message: first || "Invalid input", errors: parsed.error.flatten() });
  }
  const { currentPassword, newPassword } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(400).json({ code: "WRONG_PASSWORD", message: "Current password is incorrect." });
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      return res.status(400).json({ code: "SAME_PASSWORD", message: "Choose a password different from the current one." });
    }

    await revokeAllRefreshTokensForUser(user.id);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, 10),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
      include: {
        facility: true,
        implementation: { include: implementationInclude },
      },
    });
    await audit(req, { action: "PASSWORD_CHANGED", target: updated });

    return res.json({ message: "Password changed", ...(await issueSession(updated)) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error", error: String(err.message || err) });
  }
});

router.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Invalid input",
      errors: parsed.error.flatten(),
    });
  }

  try {
    const decoded = verifyRefreshToken(parsed.data.refreshToken);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        facility: true,
        implementation: { include: implementationInclude },
      },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // Rejects revoked tokens and tokens already exchanged (after a short grace).
    const rejected = await consumeRefreshToken(parsed.data.refreshToken, decoded);
    if (rejected) {
      return res.status(401).json({ message: "Invalid refresh token", error: rejected });
    }

    const payload = buildUserPayload(user);
    const accessToken = signAccessToken(payload);
    const token = accessToken;

    // Backward-compatible refresh response:
    // - Old apps can continue using accessToken/token and ignore refreshToken.
    // - Newer apps store the rotated refreshToken; the one they sent is retired.
    const refreshToken = await issueRefreshToken(user.id, payload);

    return res.json({
      token,
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
      refreshExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
      user: buildUserResponse(user),
    });
  } catch (err) {
    return res.status(401).json({
      message: "Invalid refresh token",
      error: String(err.message || err),
    });
  }
});

// POST /api/auth/logout  Body: { refreshToken }
// Revokes the refresh token so it can no longer be exchanged. Always 204: the
// client is logging out either way.
router.post("/logout", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (parsed.success) {
    try {
      await revokeRefreshToken(parsed.data.refreshToken);
    } catch (err) {
      console.warn("LOGOUT REVOKE FAILED", String(err.message || err));
    }
  }
  return res.status(204).end();
});

module.exports = router;