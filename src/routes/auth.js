const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
} = require("../utils");

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
  };
}

function buildUserResponse(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    facilityId: user.facilityId,
    facility: user.facility
      ? {
          id: user.facility.id,
          code: user.facility.code,
          name: user.facility.name,
        }
      : null,
  };
}

router.post("/login", async (req, res) => {
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
    include: { facility: true },
  });

  if (!user || !user.isActive) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const payload = buildUserPayload(user);

  const accessToken = signAccessToken(payload);
  const token = accessToken;
  const refreshToken = signRefreshToken(payload);

  return res.json({
    token,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    refreshExpiresIn: REFRESH_TOKEN_EXPIRES_IN,
    user: buildUserResponse(user),
  });
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
      include: { facility: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const payload = buildUserPayload(user);
    const accessToken = signAccessToken(payload);
    const token = accessToken;

    return res.json({
      token,
      accessToken,
      tokenType: "Bearer",
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
      user: buildUserResponse(user),
    });
  } catch (err) {
    return res.status(401).json({
      message: "Invalid refresh token",
      error: String(err.message || err),
    });
  }
});

module.exports = router;