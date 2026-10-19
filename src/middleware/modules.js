// Enforce per-implementation modules (LOGISTICS, PHARMACY, CLINICAL) on the
// server, not just by hiding menus. Example: South Sudan runs clinical tracking
// in DHIS2, so its users must not reach the LMIS clinical endpoints.
//
// Passes when the user's implementation has ANY of the listed modules enabled.
// SUPER_ADMIN and users without an implementation (legacy accounts) are not
// restricted, matching how the apps treat them. Use after requireAuth.
function requireModule(...modules) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });
    if (req.user.role === "SUPER_ADMIN") return next();

    const context = req.user.platformContext;
    if (!context?.implementation?.id) return next();

    const enabled = new Set(context.enabledModules || []);
    if (modules.some((m) => enabled.has(m))) return next();

    return res.status(403).json({
      code: "MODULE_DISABLED",
      message: `This feature (${modules.join(" / ")}) is not enabled for ${
        context.implementation.name || "your programme"
      }.`,
    });
  };
}

module.exports = { requireModule };
