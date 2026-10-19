// Small in-memory fixed-window rate limiter (single API process). Enough to
// slow password guessing; account lockout in routes/auth.js is the main guard.
//
// Behind a reverse proxy set TRUST_PROXY (e.g. TRUST_PROXY=1) so req.ip is the
// real client, otherwise every request shares the proxy's address and the
// IP-wide cap applies to everyone at once.

function createRateLimiter({ windowMs, max, keyFn, message, code = "RATE_LIMITED" }) {
  const hits = new Map();

  // Drop expired windows now and then so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, Math.max(windowMs, 60_000));
  sweep.unref?.();

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({ code, message, retryAfterSeconds });
    }
    return next();
  };
}

const ipOf = (req) => String(req.ip || req.socket?.remoteAddress || "unknown");
const emailOf = (req) => String(req.body?.email || "").trim().toLowerCase();

// Per address + account: 10 tries per 15 minutes.
const loginPerAccountLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  keyFn: (req) => `${ipOf(req)}|${emailOf(req)}`,
  message: "Too many sign-in attempts. Please wait a few minutes and try again.",
});

// Per address overall: generous, so a whole field office behind one IP is fine.
const loginPerIpLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 300,
  keyFn: (req) => ipOf(req),
  message: "Too many sign-in attempts from this network. Please wait a few minutes and try again.",
});

module.exports = { createRateLimiter, loginPerAccountLimiter, loginPerIpLimiter };
