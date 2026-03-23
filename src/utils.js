const jwt = require("jsonwebtoken");

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "8h";

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing in .env");

  return jwt.sign(payload, secret, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

function verifyToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing in .env");

  return jwt.verify(token, secret);
}

module.exports = { signToken, verifyToken, ACCESS_TOKEN_EXPIRES_IN };