const express = require("express");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { prisma } = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  getRefreshTokenExpiryDate,
} = require("../utils");

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

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

  const accessToken = signAccessToken({
    userId: user.id,
    role: user.role,
    facilityId: user.facilityId || null,
  });

  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await prisma.refreshToken.create({
    data: {
      tokenHash: refreshTokenHash,
      userId: user.id,
      expiresAt: getRefreshTokenExpiryDate(),
    },
  });

  return res.json({
    accessToken,
    refreshToken,
    user: {
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
    },
  });
});

router.post("/refresh", async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: "Refresh token is required",
      errors: parsed.error.flatten(),
    });
  }

  const { refreshToken } = parsed.data;
  const tokenHash = hashRefreshToken(refreshToken);

  const found = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: { facility: true },
      },
    },
  });

  if (!found || found.revokedAt || found.expiresAt < new Date()) {
    return res.status(401).json({ message: "Invalid or expired refresh token" });
  }

  if (!found.user || !found.user.isActive) {
    return res.status(401).json({ message: "User not found or disabled" });
  }

  const newAccessToken = signAccessToken({
    userId: found.user.id,
    role: found.user.role,
    facilityId: found.user.facilityId || null,
  });

  const newRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: found.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        tokenHash: newRefreshTokenHash,
        userId: found.user.id,
        expiresAt: getRefreshTokenExpiryDate(),
      },
    }),
  ]);

  return res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
});

router.post("/logout", requireAuth, async (req, res) => {
  const refreshToken = (req.body?.refreshToken || "").toString().trim();

  if (refreshToken) {
    const tokenHash = hashRefreshToken(refreshToken);

    await prisma.refreshToken.updateMany({
      where: {
        tokenHash,
        userId: req.user.id,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  return res.json({ message: "Logged out" });
});

module.exports = router;