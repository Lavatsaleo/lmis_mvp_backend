const jwt = require("jsonwebtoken");

const ACCESS_TOKEN_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";
const REFRESH_TOKEN_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "180d";

function getAccessSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET missing in .env");
  return secret;
}

function getRefreshSecret() {
  return process.env.JWT_REFRESH_SECRET || getAccessSecret();
}

function signToken(payload) {
  return jwt.sign(payload, getAccessSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

// Tokens carry `typ` so neither kind can stand in for the other, even when
// JWT_REFRESH_SECRET is not set and both are signed with the same secret.
// Tokens issued before this change have no `typ` and are still accepted.
function signAccessToken(payload) {
  return jwt.sign({ ...payload, typ: "access" }, getAccessSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  });
}

// `jti` identifies the stored RefreshToken row (see routes/auth.js).
function signRefreshToken(payload, jti) {
  return jwt.sign({ ...payload, typ: "refresh" }, getRefreshSecret(), {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    ...(jti ? { jwtid: jti } : {}),
  });
}

function verifyToken(token) {
  return verifyAccessToken(token);
}

function verifyAccessToken(token) {
  const decoded = jwt.verify(token, getAccessSecret());
  if (decoded?.typ === "refresh") throw new Error("Refresh token cannot be used as an access token");
  return decoded;
}

function verifyRefreshToken(token) {
  const decoded = jwt.verify(token, getRefreshSecret());
  if (decoded?.typ === "access") throw new Error("Access token cannot be used to refresh");
  return decoded;
}

module.exports = {
  signToken,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  verifyAccessToken,
  verifyRefreshToken,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
};