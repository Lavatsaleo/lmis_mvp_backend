// DHIS2 sync status per site, for support officers: when each site's data last
// reached DHIS2 (and Anchor), problems Anchor found with plain fixes, the
// site's recent records read live from DHIS2, a one-site re-sync and linking a
// DHIS2 site to its Anchor location.
//
// SUPER_ADMIN (any country) and COUNTRY_ADMIN (their own country).

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
  ["SUPER_ADMIN", "COUNTRY_ADMIN"].includes(req.user?.role) ? next() : res.status(403).json({ message: "Only administrators can view the DHIS2 sync status" })
);

const UID = /^[A-Za-z][A-Za-z0-9]{10}$/;
const SITE_TYPES = ["CLINIC_STORE", "PHARMACY_STORE", "OTHER"];
const DAY = 24 * 60 * 60 * 1000;

const fail = (res, err) => {
  if (err instanceof client.Dhis2Error) return res.status(502).json({ message: `DHIS2: ${err.message}` });
  console.error(err);
  return res.status(500).json({ message: "Server error", error: String(err.message || err) });
};

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

// DHIS2 times are its wall clock stored "as UTC" (see sync.wallTime); send them that way.
const wall = (d) => (d ? new Date(d).toISOString().slice(0, 19) : null);
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** Names of org units Anchor has not seen in its own records (live, best effort). */
async function orgUnitNames(uids) {
  const out = new Map();
  if (!uids.length || !client.isConfigured()) return out;
  try {
    for (let i = 0; i < uids.length; i += 100) {
      const r = await client.request("organisationUnits", { query: { filter: `id:in:[${uids.slice(i, i + 100).join(",")}]`, fields: "id,displayName,parent[displayName,parent[displayName]]", paging: "false" } });
      for (const o of r.organisationUnits || []) out.set(o.id, { name: o.displayName, payam: o.parent?.displayName || null, county: o.parent?.parent?.displayName || null });
    }
  } catch {
    // names stay unknown
  }
  return out;
}

// Sites assigned to the programs in DHIS2, so sites that never sent anything show
// too. Cached for an hour (assignments rarely change); best effort.
const assignedCache = new Map();
async function assignedSites(programIds) {
  const out = new Map();
  if (!client.isConfigured()) return out;
  for (const pid of programIds) {
    let hit = assignedCache.get(pid);
    if (!hit || Date.now() - hit.at > 60 * 60 * 1000) {
      try {
        const r = await client.request(`programs/${encodeURIComponent(pid)}`, { query: { fields: "organisationUnits[id,displayName,parent[displayName,parent[displayName]]]" } });
        hit = { at: Date.now(), units: r.organisationUnits || [] };
        assignedCache.set(pid, hit);
      } catch {
        continue;
      }
    }
    for (const o of hit.units) out.set(o.id, { name: o.displayName, payam: o.parent?.displayName || null, county: o.parent?.parent?.displayName || null });
  }
  return out;
}

const lastRun = (implementationId, direction) =>
  prisma.dhis2SyncRun.findFirst({ where: { implementationId, direction }, orderBy: { startedAt: "desc" } });

// ---------------------------------------------------------------------------
// GET /api/dhis2-sync/sites?implementationId=
// ---------------------------------------------------------------------------
router.get("/sites", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const now = client.isConfigured() ? await sync.serverWallNow() : new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    const weekAgo = new Date(now.getTime() - 7 * DAY);
    const [programs, config, facilities, children, visits, imports, pullRuns, pushRun] = await Promise.all([
      prisma.dhis2TrackerProgram.findMany({ where: { implementationId: id }, select: { id: true, code: true, programId: true, enabled: true, lastPullAt: true } }),
      prisma.dhis2Config.findUnique({ where: { implementationId: id }, select: { enabled: true, programId: true, lastPullAt: true, lastPushAt: true, intervalMinutes: true } }),
      prisma.facility.findMany({ where: { implementationId: id, dhis2OrgUnitId: { not: null } }, select: { id: true, name: true, code: true, dhis2OrgUnitId: true, county: { select: { name: true } } } }),
      prisma.dhis2Child.groupBy({
        by: ["orgUnitUid", "orgUnitName", "orgUnitParentName", "countyName"],
        where: { implementationId: id, deleted: false },
        _count: { _all: true },
        _max: { dhis2UpdatedAt: true },
      }),
      prisma.$queryRaw`
        SELECT c.orgUnitUid AS orgUnitUid, MAX(v.dhis2UpdatedAt) AS lastReceived, MAX(v.occurredAt) AS lastVisit,
               SUM(CASE WHEN v.dhis2UpdatedAt >= ${weekAgo} THEN 1 ELSE 0 END) AS recent
        FROM \`Dhis2ChildVisit\` v JOIN \`Dhis2Child\` c ON c.id = v.childId
        WHERE c.implementationId = ${id} AND c.deleted = false AND v.deleted = false
        GROUP BY c.orgUnitUid`,
      prisma.dhis2EventImport.groupBy({
        by: ["orgUnitId"],
        where: { implementationId: id },
        _count: { _all: true },
        _max: { dhis2UpdatedAt: true, occurredAt: true },
        _sum: { shortfallSachets: true },
      }),
      prisma.dhis2SyncRun.findMany({ where: { implementationId: id, direction: "PULL", status: "SUCCESS", startedAt: { gte: new Date(Date.now() - 30 * DAY) } }, select: { stats: true } }),
      prisma.dhis2SyncRun.findFirst({ where: { implementationId: id, direction: "PUSH" }, orderBy: { startedAt: "desc" } }),
    ]);

    const sites = new Map();
    const site = (uid) => {
      if (!sites.has(uid)) sites.set(uid, { orgUnitUid: uid, name: null, payam: null, county: null, facility: null, children: 0, lastReceivedAt: null, lastVisitDate: null, recentRecords: 0, problems: [] });
      return sites.get(uid);
    };
    for (const c of children) {
      const s = site(c.orgUnitUid);
      s.name = s.name || c.orgUnitName;
      s.payam = s.payam || c.orgUnitParentName;
      s.county = s.county || (c.countyName || "").replace(/\s+county$/i, "") || null;
      s.children += c._count._all;
      s.lastReceivedAt = later(s.lastReceivedAt, c._max.dhis2UpdatedAt);
    }
    for (const v of visits) {
      const s = site(v.orgUnitUid);
      s.lastReceivedAt = later(s.lastReceivedAt, v.lastReceived);
      s.lastVisitDate = later(s.lastVisitDate, v.lastVisit);
      s.recentRecords += Number(v.recent) || 0;
    }
    for (const f of facilities) {
      const s = site(f.dhis2OrgUnitId);
      s.facility = { id: f.id, name: f.name, code: f.code };
      s.name = s.name || f.name;
      s.county = s.county || f.county?.name || null;
    }
    for (const i of imports) {
      const s = site(i.orgUnitId);
      s.lastReceivedAt = later(s.lastReceivedAt, i._max.dhis2UpdatedAt);
      s.lastVisitDate = later(s.lastVisitDate, i._max.occurredAt);
      const short = i._sum.shortfallSachets || 0;
      if (short > 0) s.problems.push({ code: "SHORTFALL", sachets: short });
    }
    // Dispensing recorded in DHIS2 at sites not linked to an Anchor location (pulls of the last 30 days).
    const unmapped = {};
    for (const r of pullRuns) for (const [uid, n] of Object.entries(r.stats?.unmappedOrgUnits || {})) unmapped[uid] = (unmapped[uid] || 0) + n;
    // ...and every site assigned to the dispensing program in DHIS2 that has no Anchor location.
    const dispensing = config?.programId ? await assignedSites([config.programId]) : new Map();
    for (const uid of new Set([...Object.keys(unmapped), ...dispensing.keys()])) {
      if (!UID.test(uid)) continue;
      const s = site(uid);
      if (!s.facility) s.problems.push({ code: "NOT_LINKED", events: unmapped[uid] || 0 });
    }
    // Stock not sent: site not in the DHIS2 stock data set (last push).
    const notAssigned = new Set(pushRun?.stats?.notAssigned || []);
    for (const s of sites.values()) if (s.facility && notAssigned.has(s.facility.name)) s.problems.push({ code: "NOT_ASSIGNED" });

    // Every site assigned to the programs in DHIS2 (those with no records yet show as "never").
    const assigned = await assignedSites([...new Set([...programs.map((p) => p.programId), config?.programId].filter(Boolean))]);
    for (const [uid, o] of assigned) {
      const s = site(uid);
      s.name = s.name || o.name;
      s.payam = s.payam || o.payam;
      s.county = s.county || (o.county || "").replace(/\s+county$/i, "") || null;
    }

    const unnamed = [...sites.values()].filter((s) => !s.name).map((s) => s.orgUnitUid);
    const names = await orgUnitNames(unnamed);
    for (const uid of unnamed) {
      const s = sites.get(uid);
      const n = names.get(uid);
      s.name = n?.name || uid;
      s.payam = s.payam || n?.payam || null;
      s.county = s.county || (n?.county || "").replace(/\s+county$/i, "") || null;
    }

    const rows = [...sites.values()].map((s) => ({
      ...s,
      lastReceivedAt: wall(s.lastReceivedAt),
      lastVisitDate: s.lastVisitDate ? new Date(s.lastVisitDate).toISOString().slice(0, 10) : null,
      daysSince: s.lastReceivedAt ? Math.max(0, Math.floor((now - new Date(s.lastReceivedAt)) / DAY)) : null,
    }));

    const runs = await Promise.all([lastRun(id, "PULL"), lastRun(id, "PUSH"), ...programs.map((p) => lastRun(id, `TRACKER:${p.code}`))]);
    return res.json({
      serverNow: wall(now),
      configured: client.isConfigured(),
      intervalMinutes: config?.intervalMinutes || 60,
      stockSync: !!config?.programId,
      programs: programs.map((p) => ({ id: p.id, code: p.code, enabled: p.enabled })),
      latestRuns: runs.filter(Boolean),
      sites: rows.sort((a, b) => String(a.county || "").localeCompare(String(b.county || "")) || String(a.name).localeCompare(String(b.name))),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dhis2-sync/sites/:orgUnit/log?implementationId=
// The site's latest records read live from DHIS2: captured on the device,
// arrived in DHIS2, and whether Anchor has them.
// ---------------------------------------------------------------------------
router.get("/sites/:orgUnit/log", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const orgUnit = String(req.params.orgUnit);
    if (!UID.test(orgUnit)) return res.status(400).json({ message: "Not a valid DHIS2 org unit id" });
    if (!client.isConfigured()) return res.status(503).json({ message: "DHIS2 is not configured on the server" });

    const [programs, config, facility] = await Promise.all([
      prisma.dhis2TrackerProgram.findMany({ where: { implementationId: id }, select: { id: true, code: true, programId: true } }),
      prisma.dhis2Config.findUnique({ where: { implementationId: id }, select: { programId: true, programName: true, pullCursor: true } }),
      prisma.facility.findFirst({ where: { implementationId: id, dhis2OrgUnitId: orgUnit }, select: { id: true, name: true } }),
    ]);
    const sources = programs.map((p) => ({ programId: p.programId, code: p.code, kind: "tracker" }));
    if (config?.programId && !sources.some((s) => s.programId === config.programId)) sources.push({ programId: config.programId, code: config.programName || "Dispensing", kind: "stock" });

    const events = [];
    for (const src of sources) {
      const r = await client.request("tracker/events", {
        query: {
          program: src.programId,
          orgUnit,
          orgUnitMode: "SELECTED",
          order: "updatedAt:desc",
          pageSize: 25,
          fields: "event,programStage,status,occurredAt,createdAt,createdAtClient,updatedAt,updatedAtClient,deleted,createdBy[username],updatedBy[username]",
        },
      });
      for (const e of r.events || r.instances || []) events.push({ ...e, source: src });
    }
    events.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const latest = events.slice(0, 40);

    const stageIds = [...new Set(latest.map((e) => e.programStage).filter(Boolean))];
    const stageNames = new Map();
    if (stageIds.length) {
      try {
        const r = await client.request("programStages", { query: { filter: `id:in:[${stageIds.join(",")}]`, fields: "id,displayName", paging: "false" } });
        for (const s of r.programStages || []) stageNames.set(s.id, s.displayName);
      } catch {
        // stage names stay unknown
      }
    }
    const uids = latest.map((e) => e.event);
    const [copies, imported] = await Promise.all([
      prisma.dhis2ChildVisit.findMany({ where: { eventUid: { in: uids } }, select: { eventUid: true, dhis2UpdatedAt: true } }),
      prisma.dhis2EventImport.findMany({ where: { eventUid: { in: uids } }, select: { eventUid: true, dhis2UpdatedAt: true, reportedSachets: true, shortfallSachets: true } }),
    ]);
    const copyBy = new Map(copies.map((c) => [c.eventUid, c]));
    const importBy = new Map(imported.map((c) => [c.eventUid, c]));

    const hours = (a, b) => (a && b ? Math.round((sync.wallTime(a) - sync.wallTime(b)) / 36e5) : null);
    const records = latest.map((e) => {
      const received = sync.wallTime(e.updatedAt);
      let anchor = "MISSING";
      let sachets = null;
      if (e.source.kind === "tracker") {
        const c = copyBy.get(e.event);
        if (c) anchor = c.dhis2UpdatedAt && received && c.dhis2UpdatedAt < received ? "OLDER" : "COPIED";
      }
      const imp = importBy.get(e.event);
      if (imp) {
        sachets = { reported: imp.reportedSachets, shortfall: imp.shortfallSachets };
        if (e.source.kind === "stock") anchor = imp.dhis2UpdatedAt && received && imp.dhis2UpdatedAt < received ? "OLDER" : "COPIED";
      } else if (e.source.kind === "stock" && config?.pullCursor && received && received <= config.pullCursor) {
        anchor = facility ? "NOTHING_TO_COUNT" : "NOT_LINKED";
      }
      return {
        event: e.event,
        program: e.source.code,
        stage: stageNames.get(e.programStage) || null,
        status: e.status,
        deleted: !!e.deleted,
        visitDate: e.occurredAt ? String(e.occurredAt).slice(0, 10) : null,
        capturedAt: e.updatedAtClient || e.createdAtClient || null,
        receivedAt: e.updatedAt || null,
        firstReceivedAt: e.createdAt || null,
        delayHours: hours(e.updatedAt, e.updatedAtClient || e.createdAtClient),
        by: e.updatedBy?.username || e.createdBy?.username || null,
        anchor,
        sachets,
      };
    });

    const [shortfalls, siteRuns] = await Promise.all([
      facility
        ? prisma.dhis2EventImport.findMany({ where: { facilityId: facility.id, shortfallSachets: { gt: 0 } }, orderBy: { occurredAt: "desc" }, take: 20, select: { eventUid: true, occurredAt: true, reportedSachets: true, shortfallSachets: true } })
        : [],
      prisma.dhis2SyncRun.findMany({
        where: {
          implementationId: id,
          OR: [{ direction: { startsWith: "TRACKER_SITE:" } }, { direction: { in: ["PULL_SITE", "PUSH_SITE"] } }],
        },
        orderBy: { startedAt: "desc" },
        take: 60,
      }),
    ]);
    const mine = siteRuns.filter((r) => r.stats?.orgUnit === orgUnit || (facility && r.stats?.site === facility.name)).slice(0, 10);

    return res.json({
      orgUnit,
      facility,
      records,
      shortfalls: shortfalls.map((s) => ({ ...s, occurredAt: s.occurredAt ? s.occurredAt.toISOString().slice(0, 10) : null })),
      runs: mine,
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/dhis2-sync/sites/:orgUnit/resync { implementationId }
// Re-reads the site's children (every program) and, for a linked site, its
// dispensing from go-live, then sends its stock again.
// ---------------------------------------------------------------------------
router.post("/sites/:orgUnit/resync", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const orgUnit = String(req.params.orgUnit);
    if (!UID.test(orgUnit)) return res.status(400).json({ message: "Not a valid DHIS2 org unit id" });
    if (!client.isConfigured()) return res.status(503).json({ message: "DHIS2 is not configured on the server" });

    const [programs, config, facility, known] = await Promise.all([
      prisma.dhis2TrackerProgram.findMany({ where: { implementationId: id, enabled: true }, select: { id: true, code: true } }),
      prisma.dhis2Config.findUnique({ where: { implementationId: id }, include: { stockElements: true } }),
      prisma.facility.findFirst({ where: { implementationId: id, dhis2OrgUnitId: orgUnit }, select: { id: true, name: true } }),
      prisma.dhis2Child.findFirst({ where: { implementationId: id, orgUnitUid: orgUnit }, select: { orgUnitName: true } }),
    ]);
    const siteName = facility?.name || known?.orgUnitName || orgUnit;
    const steps = [];
    for (const p of programs) {
      const r = await tracker.syncTrackerSite(p.id, orgUnit, { siteName });
      steps.push({ step: `Children · ${p.code}`, ok: !!r.ok, skipped: r.skipped || null, error: r.error || null, stats: r.stats || null });
    }
    if (facility && config?.programId && config.dispenseDataElementId && config.dispenseProductId) {
      const r = await sync.pull(id, { trigger: "SUPPORT", orgUnit, fromStart: true });
      steps.push({ step: "Dispensing from DHIS2", ok: !!r.ok, skipped: r.skipped || null, error: r.error || null, stats: r.stats || null });
    }
    if (facility && (config?.stockElements || []).some((e) => e.boxesDataElementId || e.sachetsDataElementId)) {
      const r = await sync.push(id, { trigger: "SUPPORT", facilityId: facility.id });
      steps.push({ step: "Stock to DHIS2", ok: !!r.ok, skipped: r.skipped || null, error: r.error || null, stats: r.stats || null });
    }
    await audit(req, { action: "DHIS2_SITE_RESYNC", targetType: "IMPLEMENTATION", target: { id, name: "DHIS2" }, implementationId: id, details: { orgUnit, site: siteName, steps: steps.map((s) => ({ step: s.step, ok: s.ok })) } });
    return res.json({ site: siteName, steps });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dhis2-sync/link-options?implementationId=  Anchor sites not linked yet
// PUT /api/dhis2-sync/sites/:orgUnit/link { implementationId, facilityId }
// ---------------------------------------------------------------------------
router.get("/link-options", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const rows = await prisma.facility.findMany({
      where: { implementationId: id, stockLocationType: { in: SITE_TYPES }, dhis2OrgUnitId: null },
      select: { id: true, code: true, name: true, county: { select: { name: true } }, parentStockLocation: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    return res.json(rows.map((f) => ({ id: f.id, code: f.code, name: f.name, county: f.county?.name || null, fieldBase: f.parentStockLocation?.name || null })));
  } catch (err) {
    return fail(res, err);
  }
});

router.put("/sites/:orgUnit/link", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const orgUnit = String(req.params.orgUnit);
    if (!UID.test(orgUnit)) return res.status(400).json({ message: "Not a valid DHIS2 org unit id" });
    const facility = await prisma.facility.findFirst({ where: { id: String(req.body?.facilityId || ""), implementationId: id }, select: { id: true, name: true, dhis2OrgUnitId: true } });
    if (!facility) return res.status(404).json({ message: "Anchor location not found" });
    if (facility.dhis2OrgUnitId && facility.dhis2OrgUnitId !== orgUnit) return res.status(409).json({ message: `${facility.name} is already linked to another DHIS2 site` });
    const clash = await prisma.facility.findFirst({ where: { implementationId: id, dhis2OrgUnitId: orgUnit, id: { not: facility.id } }, select: { name: true } });
    if (clash) return res.status(409).json({ message: `This DHIS2 site is already linked to ${clash.name}` });

    await prisma.$transaction([
      prisma.facility.update({ where: { id: facility.id }, data: { dhis2OrgUnitId: orgUnit } }),
      prisma.dhis2Child.updateMany({ where: { implementationId: id, orgUnitUid: orgUnit }, data: { facilityId: facility.id } }),
    ]);
    await audit(req, { action: "DHIS2_ORG_UNIT_MAPPED", targetType: "FACILITY", target: { id: facility.id, name: facility.name }, implementationId: id, details: { from: facility.dhis2OrgUnitId, to: orgUnit, via: "sync status" } });
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId: id } });
    let backfill = false;
    if (config?.enabled && config.programId && client.isConfigured()) {
      // Count this site's dispensing from the go-live date (in the background).
      sync.pull(id, { trigger: "MAPPING", orgUnit, fromStart: true }).catch(() => {});
      backfill = true;
    }
    return res.json({ ok: true, facility: { id: facility.id, name: facility.name }, backfill });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
