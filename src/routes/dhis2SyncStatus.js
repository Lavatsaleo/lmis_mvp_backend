// Tablet sync: how data from the DHIS2 Capture app on each site's tablets is
// reaching the DHIS2 server, for support officers.
//
// A tablet's own sync errors stay on the tablet (DHIS2 does not receive them),
// so this reads what DHIS2 does record for every record that arrives: when it
// was entered on the tablet, when it reached the server, and the user account
// (normally one per tablet) that sent it. Sites whose records arrive days late,
// sites that have gone quiet and tablets with a wrong clock stand out.
//
// SUPER_ADMIN (any country) and COUNTRY_ADMIN (their own country).

const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { adminImplementationId, canAdministerImplementation } = require("../auth/access");
const client = require("../dhis2/client");
const sync = require("../dhis2/sync");

router.use(requireAuth, (req, res, next) =>
  ["SUPER_ADMIN", "COUNTRY_ADMIN"].includes(req.user?.role) ? next() : res.status(403).json({ message: "Only administrators can view tablet sync" })
);

const UID = /^[A-Za-z][A-Za-z0-9]{10}$/;
const DAY = 24 * 60 * 60 * 1000;
const LATE_HOURS = 24;
// A tablet clock more than this far ahead of the server is wrong (tablets in
// a zone behind the server's look slightly early, never hours late).
const CLOCK_AHEAD_HOURS = 2;

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
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const EVENT_FIELDS = "event,orgUnit,programStage,createdAt,createdAtClient,updatedAt,updatedAtClient,createdBy[username],updatedBy[username]";

/** DHIS2 programs whose records the tablets send: the tracker programs and the dispensing program. */
async function programSources(implementationId) {
  const [programs, config] = await Promise.all([
    prisma.dhis2TrackerProgram.findMany({ where: { implementationId }, select: { code: true, programId: true } }),
    prisma.dhis2Config.findUnique({ where: { implementationId }, select: { programId: true, programName: true } }),
  ]);
  const sources = programs.map((p) => ({ programId: p.programId, code: p.code }));
  if (config?.programId && !sources.some((s) => s.programId === config.programId)) sources.push({ programId: config.programId, code: config.programName || "Dispensing" });
  return sources;
}

// Records that reached DHIS2 in the window, read live (cached a few minutes).
const eventCache = new Map();
async function recentEvents(implementationId, sources, since) {
  const key = `${implementationId}|${since.toISOString().slice(0, 10)}`;
  const hit = eventCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.events;
  const events = [];
  const updatedAfter = since.toISOString().slice(0, 19);
  for (const src of sources) {
    for (let page = 1; page <= 200; page += 1) {
      const r = await client.request("tracker/events", { query: { program: src.programId, ouMode: "ACCESSIBLE", updatedAfter, pageSize: 1000, page, fields: EVENT_FIELDS } });
      const rows = r.events || r.instances || [];
      for (const e of rows) events.push({ ...e, program: src.code });
      if (rows.length < 1000) break;
    }
  }
  eventCache.set(key, { at: Date.now(), events });
  return events;
}

/** Hours between entry on the tablet and arrival in DHIS2 (latest edit). */
function timing(e) {
  const received = sync.wallTime(e.updatedAt);
  const entered = sync.wallTime(e.updatedAtClient || e.createdAtClient);
  return { received, entered, delayHours: received && entered ? (received - entered) / 36e5 : null, user: e.updatedBy?.username || e.createdBy?.username || null };
}

// Sites assigned to the programs in DHIS2, so sites that never sent anything
// show too. Cached for an hour; best effort.
const assignedCache = new Map();
async function assignedSites(programIds) {
  const out = new Map();
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

const blankStats = () => ({ records: 0, late: 0, clockAhead: 0, maxDelayHours: null, delays: [], lastArrival: null });
function addTo(stats, t) {
  stats.records += 1;
  stats.lastArrival = later(stats.lastArrival, t.received);
  if (t.delayHours === null) return;
  if (t.delayHours < -CLOCK_AHEAD_HOURS) {
    stats.clockAhead += 1;
    return;
  }
  const d = Math.max(0, t.delayHours);
  stats.delays.push(d);
  if (d >= LATE_HOURS) stats.late += 1;
  stats.maxDelayHours = stats.maxDelayHours === null ? d : Math.max(stats.maxDelayHours, d);
}
const finish = (stats) => ({
  records: stats.records,
  late: stats.late,
  clockAhead: stats.clockAhead,
  maxDelayHours: stats.maxDelayHours === null ? null : Math.round(stats.maxDelayHours),
  medianDelayHours: stats.delays.length ? Math.round(median(stats.delays) * 10) / 10 : null,
  lastArrival: wall(stats.lastArrival),
});

// ---------------------------------------------------------------------------
// GET /api/dhis2-sync/sites?implementationId=&days=30
// ---------------------------------------------------------------------------
router.get("/sites", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const configured = client.isConfigured();
    const now = configured ? await sync.serverWallNow() : new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    const since = new Date(now.getTime() - days * DAY);
    const sources = await programSources(id);

    // Last record from each site Anchor has ever copied (covers sites quiet for longer than the window).
    const [children, visits, imports] = await Promise.all([
      prisma.dhis2Child.groupBy({ by: ["orgUnitUid", "orgUnitName", "orgUnitParentName", "countyName"], where: { implementationId: id, deleted: false }, _max: { dhis2UpdatedAt: true } }),
      prisma.$queryRaw`
        SELECT c.orgUnitUid AS orgUnitUid, MAX(v.dhis2UpdatedAt) AS lastReceived
        FROM \`Dhis2ChildVisit\` v JOIN \`Dhis2Child\` c ON c.id = v.childId
        WHERE c.implementationId = ${id} AND c.deleted = false AND v.deleted = false
        GROUP BY c.orgUnitUid`,
      prisma.dhis2EventImport.groupBy({ by: ["orgUnitId"], where: { implementationId: id }, _max: { dhis2UpdatedAt: true } }),
    ]);

    const sites = new Map();
    const site = (uid) => {
      if (!sites.has(uid)) sites.set(uid, { orgUnitUid: uid, name: null, payam: null, county: null, lastEver: null, stats: blankStats(), users: new Map() });
      return sites.get(uid);
    };
    for (const c of children) {
      const s = site(c.orgUnitUid);
      s.name = s.name || c.orgUnitName;
      s.payam = s.payam || c.orgUnitParentName;
      s.county = s.county || (c.countyName || "").replace(/\s+county$/i, "") || null;
      s.lastEver = later(s.lastEver, c._max.dhis2UpdatedAt);
    }
    for (const v of visits) site(v.orgUnitUid).lastEver = later(site(v.orgUnitUid).lastEver, v.lastReceived);
    for (const i of imports) site(i.orgUnitId).lastEver = later(site(i.orgUnitId).lastEver, i._max.dhis2UpdatedAt);

    // Live from DHIS2: every record that arrived in the window.
    let liveError = null;
    const users = new Map();
    if (configured && sources.length) {
      try {
        const events = await recentEvents(id, sources, since);
        for (const e of events) {
          const t = timing(e);
          const s = site(e.orgUnit);
          addTo(s.stats, t);
          s.lastEver = later(s.lastEver, t.received);
          const name = t.user || "(unknown user)";
          if (!s.users.has(name)) s.users.set(name, blankStats());
          addTo(s.users.get(name), t);
          if (!users.has(name)) users.set(name, { stats: blankStats(), sites: new Set() });
          addTo(users.get(name).stats, t);
          users.get(name).sites.add(e.orgUnit);
        }
      } catch (err) {
        liveError = err.message || String(err);
      }
      const assigned = await assignedSites(sources.map((s) => s.programId));
      for (const [uid, o] of assigned) {
        const s = site(uid);
        s.name = s.name || o.name;
        s.payam = s.payam || o.payam;
        s.county = s.county || (o.county || "").replace(/\s+county$/i, "") || null;
      }
    } else if (!configured) {
      liveError = "DHIS2 is not configured on the Anchor server";
    }

    const rows = [...sites.values()].map((s) => ({
      orgUnitUid: s.orgUnitUid,
      name: s.name || s.orgUnitUid,
      payam: s.payam,
      county: s.county,
      lastReceivedAt: wall(s.lastEver),
      daysSince: s.lastEver ? Math.max(0, Math.floor((now - new Date(s.lastEver)) / DAY)) : null,
      window: finish(s.stats),
      tablets: [...s.users.entries()].map(([username, st]) => ({ username, ...finish(st) })).sort((a, b) => b.records - a.records),
    }));
    const siteName = new Map(rows.map((r) => [r.orgUnitUid, r.name]));
    return res.json({
      serverNow: wall(now),
      days,
      liveError,
      programs: sources.map((s) => s.code),
      sites: rows.sort((a, b) => String(a.county || "").localeCompare(String(b.county || "")) || String(a.name).localeCompare(String(b.name))),
      tablets: [...users.entries()]
        .map(([username, u]) => ({ username, sites: [...u.sites].map((x) => siteName.get(x) || x).sort(), ...finish(u.stats) }))
        .sort((a, b) => b.late - a.late || b.records - a.records),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dhis2-sync/sites/:orgUnit/log?implementationId=
// The site's latest records, read live from DHIS2: entered on the tablet,
// reached DHIS2, and by which user account.
// ---------------------------------------------------------------------------
router.get("/sites/:orgUnit/log", async (req, res) => {
  try {
    const id = implId(req, res);
    if (!id) return;
    const orgUnit = String(req.params.orgUnit);
    if (!UID.test(orgUnit)) return res.status(400).json({ message: "Not a valid DHIS2 org unit id" });
    if (!client.isConfigured()) return res.status(503).json({ message: "DHIS2 is not configured on the server" });

    const sources = await programSources(id);
    const events = [];
    for (const src of sources) {
      const r = await client.request("tracker/events", {
        query: { program: src.programId, orgUnit, orgUnitMode: "SELECTED", order: "updatedAt:desc", pageSize: 30, fields: `${EVENT_FIELDS},status,occurredAt,deleted` },
      });
      for (const e of r.events || r.instances || []) events.push({ ...e, program: src.code });
    }
    events.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    const latest = events.slice(0, 50);

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
    return res.json({
      orgUnit,
      records: latest.map((e) => {
        const t = timing(e);
        return {
          event: e.event,
          program: e.program,
          stage: stageNames.get(e.programStage) || null,
          status: e.status,
          deleted: !!e.deleted,
          visitDate: e.occurredAt ? String(e.occurredAt).slice(0, 10) : null,
          enteredAt: e.updatedAtClient || e.createdAtClient || null,
          receivedAt: e.updatedAt || null,
          delayHours: t.delayHours === null ? null : Math.round(t.delayHours),
          clockAhead: t.delayHours !== null && t.delayHours < -CLOCK_AHEAD_HOURS,
          by: t.user,
        };
      }),
    });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
