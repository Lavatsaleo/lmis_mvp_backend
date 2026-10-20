// Shared platform-context helpers used by login, refresh and /api/me.
// Keeping this in one place prevents the mobile app and web dashboard from
// receiving different country/implementation/module shapes.

const implementationInclude = {
  country: {
    select: {
      id: true,
      code: true,
      name: true,
      isActive: true,
    },
  },
  modules: {
    where: { isEnabled: true },
    select: { module: true },
    orderBy: { module: "asc" },
  },
  // Children read from DHIS2 tracker programs (shows the Children page where
  // the clinical module is off, e.g. South Sudan).
  dhis2TrackerPrograms: {
    where: { enabled: true },
    select: { code: true },
  },
};

function buildPlatformContext(user) {
  const implementation = user?.implementation;
  if (!implementation) return null;

  return {
    country: implementation.country
      ? {
          id: implementation.country.id,
          code: implementation.country.code,
          name: implementation.country.name,
        }
      : null,
    implementation: {
      id: implementation.id,
      code: implementation.code,
      name: implementation.name,
      reportingCurrencyCode: implementation.reportingCurrencyCode || "USD",
      // Mobile stock-control tools (receive PO, stock count, report loss).
      warehouseTools: !!implementation.warehouseTools,
      trackerPrograms: Array.isArray(implementation.dhis2TrackerPrograms) ? implementation.dhis2TrackerPrograms.map((p) => p.code) : [],
    },
    enabledModules: Array.isArray(implementation.modules)
      ? implementation.modules.map((row) => row.module)
      : [],
  };
}

module.exports = {
  implementationInclude,
  buildPlatformContext,
};
