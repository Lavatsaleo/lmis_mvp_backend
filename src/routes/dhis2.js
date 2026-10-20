// DHIS2 integration admin: connection check, metadata pickers, configuration,
// site <-> organisation unit mapping, manual sync, run history and imports.
// SUPER_ADMIN only: the connection and settings affect every country's data.

const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { adminImplementationId, canAdministerImplementation } = require("../auth/access");
const { audit } = require("../auth/audit");
const client = require("../dhis2/client");
const sync = require("../dhis2/sync");
const tracker = require("../dhis2/tracker");

router.use(requireAuth, (req, res, next) =>
  req.user?.role === "SUPER_ADMIN" ? next() : res.status(403).json({ message: "Only a Super Admin can manage the DHIS2 integration" })
);

const SITE_TYPES = ["CLINIC_STORE", "PHARMACY_STORE", "OTHER"];
const PERIOD_TYPES = new Set(["Daily", "Weekly", "Monthly"]);
const UID = /^[A-Za-z][A-Za-z0-9]{10}$/;

const fail = (res, err) => {
  if (err instanceof client.Dhis2Error) return res.status(err.status >= 400 && err.status < 600 ? (err.status === 401 || err.status === 403 ? 502 : err.status) : 502).json({ message: err.message });
  console.error(err);
  return res.status(500).json({ message: "Server error", error: String(err.message || err) });
};

// Which implementation this request is about (country admin: always their own).
function implId(req, res) {
  const id = adminImplementationId(req, req.body?.implementationId);
  if (!id || id === "__none__") {
    res.status(400).json({ message: "implementationId is required" });
    return null;
  }
  if (!canAdministerImplementation(req.user, id)) {
    res.status(404).json({ message: "Implementation not found" });
    return null;
  }
  return id;
}

const serverLabel = () => {
  const c = client.connection();
  if (!c) return null;
  try {
    return new URL(c.baseUrl).host;
  } catch {
    return c.baseUrl;
  }
};

async function loadConfig(implementationId) {
  return prisma.dhis2Config.findUnique({
    where: { implementationId },
    include: { stockElements: { include: { product: { select: { id: true, code: true, name: true } } } } },
  });
}

// GET /api/dhis2/status?implementationId=
router.get("/status", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const [config, sites, mapped, shortfall, runs, products] = await Promise.all([
      loadConfig(id),
      prisma.facility.count({ where: { implementationId: id, stockLocationType: { in: SITE_TYPES } } }),
      prisma.facility.count({ where: { implementationId: id, dhis2OrgUnitId: { not: null } } }),
      prisma.dhis2EventImport.aggregate({ where: { implementationId: id, shortfallSachets: { gt: 0 } }, _sum: { shortfallSachets: true }, _count: { _all: true } }),
      prisma.dhis2SyncRun.findMany({ where: { implementationId: id }, orderBy: { startedAt: "desc" }, take: 6 }),
      prisma.product.findMany({ where: { implementationId: id, isActive: true }, select: { id: true, code: true, name: true, unitsPerPack: true, baseUnitName: true }, orderBy: { name: "asc" } }),
    ]);
    return res.json({
      configured: client.isConfigured(),
      running: sync.isRunning(id),
      server: serverLabel(),
      config,
      products,
      counts: { sites, mapped, shortfallEvents: shortfall._count._all, shortfallSachets: shortfall._sum.shortfallSachets || 0 },
      recentRuns: runs,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// GET /api/dhis2/test  - can the server reach DHIS2 with its credentials?
router.get("/test", async (req, res) => {
  try {
    return res.json({ ok: true, server: serverLabel(), ...(await client.systemInfo()) });
  } catch (err) {
    return fail(res, err);
  }
});

// Metadata pickers
router.get("/metadata/programs", async (req, res) => {
  try {
    return res.json(await client.programs());
  } catch (err) {
    return fail(res, err);
  }
});
router.get("/metadata/programs/:id", async (req, res) => {
  try {
    if (!UID.test(req.params.id)) return res.status(400).json({ message: "Invalid program id" });
    return res.json(await client.program(req.params.id));
  } catch (err) {
    return fail(res, err);
  }
});
router.get("/metadata/data-elements", async (req, res) => {
  try {
    const q = String(req.query.q || "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60);
    return res.json(await client.aggregateDataElements(q));
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/dhis2/config  { implementationId, enabled, programId, ..., stockElements: [{productId, boxesDataElementId, sachetsDataElementId}] }
router.put("/config", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const b = req.body || {};
    const uidOrNull = (v, label) => {
      const s = v ? String(v).trim() : "";
      if (!s) return null;
      if (!UID.test(s)) throw Object.assign(new Error(`${label} is not a valid DHIS2 id`), { http: 400 });
      return s;
    };
    const data = {};
    if (b.enabled !== undefined) data.enabled = !!b.enabled;
    if (b.programId !== undefined) data.programId = uidOrNull(b.programId, "Program");
    if (b.programName !== undefined) data.programName = b.programName ? String(b.programName).slice(0, 191) : null;
    if (b.programStageId !== undefined) data.programStageId = uidOrNull(b.programStageId, "Program stage");
    if (b.dispenseDataElementId !== undefined) data.dispenseDataElementId = uidOrNull(b.dispenseDataElementId, "Data element");
    if (b.dispenseDataElementName !== undefined) data.dispenseDataElementName = b.dispenseDataElementName ? String(b.dispenseDataElementName).slice(0, 191) : null;
    if (b.countStatuses !== undefined) {
      const list = String(b.countStatuses).split(",").map((x) => x.trim().toUpperCase()).filter((x) => ["ACTIVE", "COMPLETED", "SCHEDULE", "SKIPPED", "VISITED", "OVERDUE"].includes(x));
      if (!list.length) return res.status(400).json({ message: "Pick at least one event status" });
      data.countStatuses = list.join(",");
    }
    if (b.startDate !== undefined) {
      if (!b.startDate) data.startDate = null;
      else {
        const d = new Date(`${String(b.startDate).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return res.status(400).json({ message: "Invalid start date" });
        data.startDate = d;
      }
    }
    if (b.stockPeriodType !== undefined) {
      if (!PERIOD_TYPES.has(b.stockPeriodType)) return res.status(400).json({ message: "Period type must be Daily, Weekly or Monthly" });
      data.stockPeriodType = b.stockPeriodType;
    }
    if (b.intervalMinutes !== undefined) {
      const n = Math.floor(Number(b.intervalMinutes));
      if (!(n >= 15 && n <= 1440)) return res.status(400).json({ message: "Sync interval must be 15 to 1440 minutes" });
      data.intervalMinutes = n;
    }
    const productIds = new Set(
      (await prisma.product.findMany({ where: { implementationId: id }, select: { id: true } })).map((p) => p.id)
    );
    if (b.dispenseProductId !== undefined) {
      if (b.dispenseProductId && !productIds.has(String(b.dispenseProductId))) return res.status(400).json({ message: "Product not found in this country" });
      data.dispenseProductId = b.dispenseProductId ? String(b.dispenseProductId) : null;
    }
    let elements = null;
    if (Array.isArray(b.stockElements)) {
      elements = [];
      for (const e of b.stockElements) {
        if (!productIds.has(String(e.productId))) return res.status(400).json({ message: "Stock element product not found in this country" });
        const boxes = uidOrNull(e.boxesDataElementId, "Boxes data element");
        const sachets = uidOrNull(e.sachetsDataElementId, "Sachets data element");
        if (boxes || sachets) elements.push({ productId: String(e.productId), boxesDataElementId: boxes, sachetsDataElementId: sachets });
      }
    }

    const before = await prisma.dhis2Config.findUnique({ where: { implementationId: id } });
    // Changing the source of dispensing restarts the cursor so history is read with the new settings.
    const sourceChanged =
      before &&
      ((data.programId !== undefined && data.programId !== before.programId) ||
        (data.programStageId !== undefined && data.programStageId !== before.programStageId) ||
        (data.dispenseDataElementId !== undefined && data.dispenseDataElementId !== before.dispenseDataElementId));
    if (sourceChanged) data.pullCursor = null;

    const config = await prisma.$transaction(async (tx) => {
      const c = await tx.dhis2Config.upsert({ where: { implementationId: id }, create: { implementationId: id, ...data }, update: data });
      if (elements) {
        await tx.dhis2StockElement.deleteMany({ where: { configId: c.id } });
        if (elements.length) await tx.dhis2StockElement.createMany({ data: elements.map((e) => ({ ...e, configId: c.id })) });
      }
      return c;
    });
    if (config.enabled && (!config.programId || !config.dispenseDataElementId || !config.dispenseProductId)) {
      await prisma.dhis2Config.update({ where: { id: config.id }, data: { enabled: false } });
    }
    await audit(req, { action: "DHIS2_CONFIG_CHANGED", targetType: "IMPLEMENTATION", target: { id, name: "DHIS2" }, implementationId: id, details: { ...data, stockElements: elements || undefined } });
    return res.json(await loadConfig(id));
  } catch (err) {
    if (err.http) return res.status(err.http).json({ message: err.message });
    return fail(res, err);
  }
});

// GET /api/dhis2/org-units?implementationId=
// Anchor sites with their mapped org unit, plus the program's org units (when reachable).
router.get("/org-units", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const sites = await prisma.facility.findMany({
      where: { implementationId: id, OR: [{ stockLocationType: { in: SITE_TYPES } }, { dhis2OrgUnitId: { not: null } }] },
      select: {
        id: true,
        code: true,
        name: true,
        dhis2OrgUnitId: true,
        county: { select: { name: true } },
        parentStockLocation: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId: id } });
    let orgUnits = [];
    let orgUnitError = null;
    if (config?.programId && client.isConfigured()) {
      try {
        orgUnits = (await client.program(config.programId)).organisationUnits || [];
      } catch (err) {
        orgUnitError = err.message;
      }
    }
    return res.json({ sites, orgUnits, orgUnitError });
  } catch (err) {
    return fail(res, err);
  }
});

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\b(phcc|phcu|primary health care (centre|center|unit)|health (centre|center|facility)|hospital|clinic|otp|tsfp|site|nutrition)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// POST /api/dhis2/org-units/auto-match { implementationId, apply }
// Suggests org units for unmapped sites by code or name; apply=true saves them.
router.post("/org-units/auto-match", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId: id } });
    if (!config?.programId) return res.status(400).json({ message: "Choose the DHIS2 program first" });
    const orgUnits = (await client.program(config.programId)).organisationUnits || [];
    const sites = await prisma.facility.findMany({
      where: { implementationId: id, stockLocationType: { in: SITE_TYPES }, dhis2OrgUnitId: null },
      select: { id: true, code: true, name: true },
    });
    const taken = new Set(
      (await prisma.facility.findMany({ where: { implementationId: id, dhis2OrgUnitId: { not: null } }, select: { dhis2OrgUnitId: true } })).map((f) => f.dhis2OrgUnitId)
    );
    const byCode = new Map();
    const byName = new Map();
    for (const ou of orgUnits) {
      if (ou.code) byCode.set(String(ou.code).toLowerCase(), ou);
      const k = norm(ou.displayName);
      if (k) byName.set(k, byName.has(k) ? null : ou); // ambiguous names are skipped
    }
    const matches = [];
    for (const s of sites) {
      const ou = byCode.get(String(s.code).toLowerCase()) || byName.get(norm(s.name)) || null;
      if (ou && !taken.has(ou.id)) {
        taken.add(ou.id);
        matches.push({ facilityId: s.id, siteName: s.name, orgUnitId: ou.id, orgUnitName: ou.displayName, by: byCode.get(String(s.code).toLowerCase()) ? "code" : "name" });
      }
    }
    if (req.body?.apply) {
      for (const m of matches) await prisma.facility.update({ where: { id: m.facilityId }, data: { dhis2OrgUnitId: m.orgUnitId } });
      await audit(req, { action: "DHIS2_ORG_UNITS_MAPPED", targetType: "IMPLEMENTATION", target: { id, name: "DHIS2" }, implementationId: id, details: { count: matches.length, auto: true } });
      if (matches.length && config.enabled) sync.pull(id, { trigger: "MAPPING", fromStart: true }).catch(() => {});
    }
    return res.json({ matches, unmatched: sites.length - matches.length });
  } catch (err) {
    return fail(res, err);
  }
});

// PUT /api/dhis2/org-units/:facilityId { dhis2OrgUnitId | null }
router.put("/org-units/:facilityId", async (req, res) => {
  try {
    const site = await prisma.facility.findUnique({ where: { id: String(req.params.facilityId) }, select: { id: true, name: true, implementationId: true, dhis2OrgUnitId: true } });
    if (!site || !canAdministerImplementation(req.user, site.implementationId)) return res.status(404).json({ message: "Site not found" });
    const ou = req.body?.dhis2OrgUnitId ? String(req.body.dhis2OrgUnitId).trim() : null;
    if (ou && !UID.test(ou)) return res.status(400).json({ message: "Not a valid DHIS2 org unit id" });
    if (ou) {
      const clash = await prisma.facility.findFirst({ where: { implementationId: site.implementationId, dhis2OrgUnitId: ou, id: { not: site.id } }, select: { name: true } });
      if (clash) return res.status(409).json({ message: `That org unit is already linked to ${clash.name}` });
    }
    const pendingStock = site.dhis2OrgUnitId && site.dhis2OrgUnitId !== ou
      ? await prisma.dhis2EventImport.count({ where: { facilityId: site.id, reportedSachets: { gt: 0 } } })
      : 0;
    await prisma.facility.update({ where: { id: site.id }, data: { dhis2OrgUnitId: ou } });
    await audit(req, { action: "DHIS2_ORG_UNIT_MAPPED", targetType: "FACILITY", target: { id: site.id, name: site.name }, implementationId: site.implementationId, details: { from: site.dhis2OrgUnitId, to: ou } });
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId: site.implementationId } });
    let backfill = false;
    if (ou && config?.enabled && client.isConfigured()) {
      // Bring in this site's visits from the go-live date (runs in the background).
      sync.pull(site.implementationId, { trigger: "MAPPING", orgUnit: ou, fromStart: true }).catch(() => {});
      backfill = true;
    }
    return res.json({ ok: true, dhis2OrgUnitId: ou, backfill, previouslyImportedEvents: pendingStock });
  } catch (err) {
    return fail(res, err);
  }
});

// POST /api/dhis2/sync { implementationId, direction: PULL|PUSH|BOTH, fromStart, facilityId }
// facilityId: only that linked site (the automatic sync always does every site).
router.post("/sync", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    if (!client.isConfigured()) return res.status(503).json({ message: "DHIS2 is not configured on the server (set DHIS2_URL and DHIS2_TOKEN in .env)" });
    const direction = String(req.body?.direction || "BOTH").toUpperCase();
    let site = null;
    if (req.body?.facilityId) {
      site = await prisma.facility.findFirst({ where: { id: String(req.body.facilityId), implementationId: id }, select: { id: true, name: true, dhis2OrgUnitId: true } });
      if (!site) return res.status(404).json({ message: "Site not found" });
      if (!site.dhis2OrgUnitId) return res.status(400).json({ message: `${site.name} is not linked to a DHIS2 org unit` });
    }
    const fromStart = !!req.body?.fromStart;
    const out = {};
    if (direction === "PULL" || direction === "BOTH") out.pull = await sync.pull(id, { trigger: "MANUAL", fromStart, orgUnit: site?.dhis2OrgUnitId || null });
    if (direction === "PUSH" || direction === "BOTH") out.push = await sync.push(id, { trigger: "MANUAL", facilityId: site?.id || null });
    await audit(req, { action: "DHIS2_SYNC_RUN", targetType: "IMPLEMENTATION", target: { id, name: "DHIS2" }, implementationId: id, details: { direction, fromStart, site: site?.name } });
    return res.json(out);
  } catch (err) {
    return fail(res, err);
  }
});

// GET /api/dhis2/stock-preview?implementationId=  - what the next push would send
router.get("/stock-preview", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const config = await loadConfig(id);
    const elements = config?.stockElements || [];
    const snap = await sync.stockSnapshot(id, elements.map((e) => e.productId));
    const rows = [];
    for (const site of snap.sites) {
      for (const el of elements) rows.push({ facilityId: site.id, siteName: site.name, orgUnitId: site.dhis2OrgUnitId, product: el.product, ...snap.get(site.id, el.productId) });
    }
    const serverDay = client.isConfigured() ? await sync.serverWallNow() : undefined;
    return res.json({ period: sync.periodFor(config?.stockPeriodType || "Daily", serverDay), rows });
  } catch (err) {
    return fail(res, err);
  }
});

// GET /api/dhis2/runs?implementationId=&limit=
router.get("/runs", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const take = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    return res.json(await prisma.dhis2SyncRun.findMany({ where: { implementationId: id }, orderBy: { startedAt: "desc" }, take }));
  } catch (err) {
    return fail(res, err);
  }
});

// GET /api/dhis2/imports?implementationId=&facilityId=&shortfall=1&page=
router.get("/imports", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const where = { implementationId: id };
    if (req.query.facilityId) where.facilityId = String(req.query.facilityId);
    if (req.query.shortfall === "1") where.shortfallSachets = { gt: 0 };
    const page = Math.max(1, Number(req.query.page) || 1);
    const [total, rows, bySite] = await Promise.all([
      prisma.dhis2EventImport.count({ where }),
      prisma.dhis2EventImport.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * 100,
        take: 100,
        include: { facility: { select: { name: true, code: true } } },
      }),
      prisma.dhis2EventImport.groupBy({
        by: ["facilityId"],
        where: { implementationId: id },
        _count: { _all: true },
        _sum: { reportedSachets: true, deductedSachets: true, shortfallSachets: true },
      }),
    ]);
    const names = new Map(
      (await prisma.facility.findMany({ where: { id: { in: bySite.map((s) => s.facilityId).filter(Boolean) } }, select: { id: true, name: true } })).map((f) => [f.id, f.name])
    );
    return res.json({
      total,
      page,
      rows,
      bySite: bySite
        .map((s) => ({ facilityId: s.facilityId, siteName: names.get(s.facilityId) || "(unmapped)", events: s._count._all, reported: s._sum.reportedSachets || 0, deducted: s._sum.deductedSachets || 0, shortfall: s._sum.shortfallSachets || 0 }))
        .sort((a, b) => b.reported - a.reported),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Tracker programs (children copied from DHIS2, e.g. OTP)
// ---------------------------------------------------------------------------
const trackerRow = async (p) => {
  const [children, active, lastRun] = await Promise.all([
    prisma.dhis2Child.count({ where: { programConfigId: p.id, deleted: false } }),
    prisma.dhis2Child.count({ where: { programConfigId: p.id, deleted: false, outcome: null, enrollmentStatus: "ACTIVE" } }),
    prisma.dhis2SyncRun.findFirst({ where: { implementationId: p.implementationId, direction: `TRACKER:${p.code}` }, orderBy: { startedAt: "desc" } }),
  ]);
  return {
    id: p.id,
    implementationId: p.implementationId,
    programId: p.programId,
    code: p.code,
    name: p.name,
    enabled: p.enabled,
    commodity: p.commodity,
    startDate: p.startDate,
    lastPullAt: p.lastPullAt,
    mapping: p.mapping,
    labels: p.labels,
    children,
    inTreatment: active,
    running: tracker.isTrackerRunning(p.id),
    lastRun,
  };
};

// GET /api/dhis2/tracker-programs?implementationId=
router.get("/tracker-programs", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const rows = await prisma.dhis2TrackerProgram.findMany({ where: { implementationId: id }, orderBy: { code: "asc" } });
    return res.json(await Promise.all(rows.map(trackerRow)));
  } catch (err) {
    return fail(res, err);
  }
});

const cleanCode = (v, fallback) => String(v || fallback || "").trim().slice(0, 20);
const dateOrNullSafe = (v) => {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error("Invalid start date"), { http: 400 });
  return d;
};

// POST /api/dhis2/tracker-programs { implementationId, programId, code?, commodity?, startDate?, enabled? }
router.post("/tracker-programs", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const programId = String(req.body?.programId || "").trim();
    if (!UID.test(programId)) return res.status(400).json({ message: "Choose a DHIS2 tracker program" });
    if (await prisma.dhis2TrackerProgram.findUnique({ where: { implementationId_programId: { implementationId: id, programId } } })) {
      return res.status(409).json({ message: "This program is already added" });
    }
    const detected = await tracker.detectMapping(programId);
    const created = await prisma.dhis2TrackerProgram.create({
      data: {
        implementationId: id,
        programId,
        name: detected.program.name,
        code: cleanCode(req.body?.code, detected.program.name),
        commodity: req.body?.commodity ? String(req.body.commodity).trim().slice(0, 40) : null,
        startDate: dateOrNullSafe(req.body?.startDate),
        enabled: !!req.body?.enabled,
        mapping: detected.mapping,
        labels: detected.labels,
      },
    });
    await audit(req, { action: "DHIS2_TRACKER_PROGRAM_ADDED", targetType: "IMPLEMENTATION", target: { id, name: created.name }, implementationId: id, details: { programId, code: created.code } });
    return res.status(201).json(await trackerRow(created));
  } catch (err) {
    if (err.http) return res.status(err.http).json({ message: err.message });
    return fail(res, err);
  }
});

// PATCH /api/dhis2/tracker-programs/:pid { enabled?, commodity?, startDate?, code?, remap? }
router.patch("/tracker-programs/:pid", async (req, res) => {
  try {
    const p = await prisma.dhis2TrackerProgram.findUnique({ where: { id: String(req.params.pid) } });
    if (!p || !canAdministerImplementation(req.user, p.implementationId)) return res.status(404).json({ message: "Program not found" });
    const b = req.body || {};
    const data = {};
    if (b.enabled !== undefined) data.enabled = !!b.enabled;
    if (b.commodity !== undefined) data.commodity = b.commodity ? String(b.commodity).trim().slice(0, 40) : null;
    if (b.startDate !== undefined) data.startDate = dateOrNullSafe(b.startDate);
    if (b.code !== undefined) data.code = cleanCode(b.code, p.code);
    if (b.remap) {
      const detected = await tracker.detectMapping(p.programId);
      data.mapping = detected.mapping;
      data.labels = detected.labels;
      data.name = detected.program.name;
    }
    // A new start date or mapping needs a full re-read on the next sync.
    if (data.startDate !== undefined || data.mapping) data.pullCursor = null;
    const updated = await prisma.dhis2TrackerProgram.update({ where: { id: p.id }, data });
    await audit(req, { action: "DHIS2_TRACKER_PROGRAM_CHANGED", targetType: "IMPLEMENTATION", target: { id: p.implementationId, name: p.name }, implementationId: p.implementationId, details: { ...b } });
    return res.json(await trackerRow(updated));
  } catch (err) {
    if (err.http) return res.status(err.http).json({ message: err.message });
    return fail(res, err);
  }
});

// POST /api/dhis2/tracker-programs/:pid/sync { fromStart? }
// Starts in the background (the first full read can take minutes) and returns at once.
router.post("/tracker-programs/:pid/sync", async (req, res) => {
  try {
    const p = await prisma.dhis2TrackerProgram.findUnique({ where: { id: String(req.params.pid) } });
    if (!p || !canAdministerImplementation(req.user, p.implementationId)) return res.status(404).json({ message: "Program not found" });
    if (!client.isConfigured()) return res.status(503).json({ message: "DHIS2 is not configured on the server" });
    if (tracker.isTrackerRunning(p.id)) return res.json({ started: false, message: "Already syncing" });
    tracker.syncTrackerProgram(p.id, { trigger: "MANUAL", fromStart: !!req.body?.fromStart }).catch((e) => console.error("tracker sync", e));
    await audit(req, { action: "DHIS2_TRACKER_SYNC", targetType: "IMPLEMENTATION", target: { id: p.implementationId, name: p.name }, implementationId: p.implementationId, details: { fromStart: !!req.body?.fromStart } });
    return res.json({ started: true, message: p.pullCursor && !req.body?.fromStart ? "Reading changes from DHIS2" : "Reading all children from DHIS2; this can take a few minutes" });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
