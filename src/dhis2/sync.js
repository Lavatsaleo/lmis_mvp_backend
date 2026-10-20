// DHIS2 <-> Anchor sync for one implementation.
//
// PULL: visit events of the configured tracker program carry "sachets
// dispensed". For each event Anchor keeps what it last processed and applies
// only the difference to the site's stock (earliest expiry first). Edits apply
// the change, deleted / non-counting events give their sachets back. When the
// site has too little stock in Anchor the gap is recorded as a shortfall and
// settled on later pulls once stock is there.
//
// PUSH: boxes and sachets remaining per product per mapped site are written to
// the configured aggregate data elements for today's period.

const prisma = require("../lib/prisma");
const client = require("./client");

const OVERLAP_MS = 5 * 60 * 1000;
const running = new Set();

// DHIS2 timestamps carry no time zone: they are the server's wall clock.
// Anchor keeps them as that wall time stored "as UTC" and sends them back the
// same way, so the cursor matches DHIS2 whatever zone either machine is in.
const wallTime = (s) => {
  if (!s) return null;
  const str = String(s);
  const d = /([zZ]|[+-]\d\d:?\d\d)$/.test(str) ? new Date(str) : new Date(`${str.slice(0, 23)}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
// A visit date is a calendar day: keep the day, stored at 12:00 UTC.
const visitDay = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null);
const dayAsDate = (day) => (day ? new Date(`${day}T12:00:00Z`) : null);

// DHIS2's own wall clock (falls back to this machine's local wall time).
async function serverWallNow() {
  try {
    const d = wallTime((await client.request("system/info")).serverDate);
    if (d) return d;
  } catch {
    // fall through
  }
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000);
}

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

async function startRun(implementationId, direction, trigger) {
  return prisma.dhis2SyncRun.create({ data: { implementationId, direction, trigger } });
}
async function finishRun(run, status, stats, error) {
  return prisma.dhis2SyncRun.update({
    where: { id: run.id },
    data: { status, stats: stats || undefined, error: error ? String(error).slice(0, 4000) : null, finishedAt: new Date() },
  });
}

// ---------------------------------------------------------------------------
// Stock movements
// ---------------------------------------------------------------------------
async function deduct(tx, { facilityId, productId, sachets, eventImportId, occurredAt }) {
  const boxes = await tx.box.findMany({
    where: { currentFacilityId: facilityId, productId, status: "IN_FACILITY", sachetsRemaining: { gt: 0 } },
    orderBy: [{ expiryDate: "asc" }, { boxUid: "asc" }],
    select: { id: true, sachetsRemaining: true },
  });
  let left = sachets;
  const lines = [];
  for (const b of boxes) {
    if (left <= 0) break;
    const take = Math.min(left, b.sachetsRemaining);
    const r = await tx.box.updateMany({
      where: { id: b.id, status: "IN_FACILITY", currentFacilityId: facilityId, sachetsRemaining: { gte: take } },
      data: { sachetsRemaining: { decrement: take } },
    });
    if (r.count === 1) {
      lines.push({ boxId: b.id, sachets: take });
      left -= take;
    }
  }
  const taken = sachets - left;
  if (taken > 0) {
    await tx.stockConsumption.create({
      data: { facilityId, productId, sachets: taken, occurredAt: occurredAt || new Date(), eventImportId, lines: { create: lines } },
    });
  }
  return taken;
}

// Give back up to `sachets` to the boxes this event took from (latest first).
async function giveBack(tx, { facilityId, productId, sachets, eventImportId, occurredAt }) {
  const prior = await tx.stockConsumptionLine.findMany({
    where: { consumption: { eventImportId } },
    orderBy: { id: "desc" },
    select: { boxId: true, sachets: true },
  });
  // Net sachets still taken per box for this event.
  const net = new Map();
  for (const l of prior) net.set(l.boxId, (net.get(l.boxId) || 0) + l.sachets);
  let left = sachets;
  const lines = [];
  for (const [boxId, taken] of net) {
    if (left <= 0) break;
    if (taken <= 0) continue;
    const box = await tx.box.findUnique({ where: { id: boxId }, select: { status: true, currentFacilityId: true, sachetsRemaining: true, sachetsPerBox: true } });
    if (!box || box.status !== "IN_FACILITY" || box.currentFacilityId !== facilityId) continue;
    const room = Math.max(0, box.sachetsPerBox - box.sachetsRemaining);
    const back = Math.min(left, taken, room);
    if (back <= 0) continue;
    await tx.box.update({ where: { id: boxId }, data: { sachetsRemaining: { increment: back } } });
    lines.push({ boxId, sachets: -back });
    left -= back;
  }
  const returned = sachets - left;
  if (returned > 0) {
    await tx.stockConsumption.create({
      data: { facilityId, productId, sachets: -returned, occurredAt: occurredAt || new Date(), eventImportId, lines: { create: lines } },
    });
  }
  return returned;
}

// Bring an imported event to `target` sachets (positive or negative change).
async function applyTarget(tx, imp, { target, facilityId, productId, occurredAt }) {
  let { reportedSachets, deductedSachets, shortfallSachets } = imp;
  const delta = target - reportedSachets;
  if (delta > 0) {
    const taken = await deduct(tx, { facilityId, productId, sachets: delta, eventImportId: imp.id, occurredAt });
    deductedSachets += taken;
    shortfallSachets += delta - taken;
  } else if (delta < 0) {
    let give = -delta;
    const fromShortfall = Math.min(shortfallSachets, give);
    shortfallSachets -= fromShortfall;
    give -= fromShortfall;
    if (give > 0) {
      const returned = await giveBack(tx, { facilityId, productId, sachets: give, eventImportId: imp.id, occurredAt });
      deductedSachets -= returned;
    }
  }
  reportedSachets = target;
  return { reportedSachets, deductedSachets, shortfallSachets, delta };
}

// ---------------------------------------------------------------------------
// PULL
// ---------------------------------------------------------------------------
// orgUnit: only that site's visits (manual one-site pull, or back-fill after
// linking with fromStart). The shared cursor only moves on full pulls.
async function pull(implementationId, { trigger = "SCHEDULE", orgUnit = null, fromStart = false } = {}) {
  const key = `pull:${implementationId}`;
  if (running.has(key)) return { skipped: "A pull is already running" };
  running.add(key);
  const run = await startRun(implementationId, orgUnit ? "PULL_SITE" : "PULL", trigger);
  const stats = { events: 0, applied: 0, unchanged: 0, sachetsDeducted: 0, sachetsReturned: 0, newShortfall: 0, settledShortfall: 0, unmappedEvents: 0, unmappedOrgUnits: {} };
  try {
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId } });
    if (!config?.programId || !config.dispenseDataElementId || !config.dispenseProductId) {
      throw new Error("Choose the DHIS2 program, data element and product first");
    }
    const statuses = new Set(config.countStatuses.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
    const sites = await prisma.facility.findMany({
      where: { implementationId, dhis2OrgUnitId: { not: null } },
      select: { id: true, name: true, dhis2OrgUnitId: true },
    });
    const siteByOu = new Map(sites.map((s) => [s.dhis2OrgUnitId, s.id]));
    if (orgUnit) {
      if (!siteByOu.has(orgUnit)) throw new Error("That org unit is not linked to a site");
      stats.orgUnit = orgUnit;
      stats.site = sites.find((x) => x.dhis2OrgUnitId === orgUnit).name;
    }

    // DHIS2's own clock, used as the cursor when no events come back.
    const serverNow = await serverWallNow();
    const startDay = config.startDate ? config.startDate.toISOString().slice(0, 10) : null;
    const since = fromStart ? config.startDate || null : config.pullCursor ? new Date(config.pullCursor.getTime() - OVERLAP_MS) : config.startDate || null;
    let maxUpdated = config.pullCursor;

    for (let page = 1; page <= 2000; page += 1) {
      const { events, more } = await client.eventsPage({ programId: config.programId, programStageId: config.programStageId || undefined, updatedAfter: since, orgUnit: orgUnit || undefined, page });
      for (const e of events) {
        stats.events += 1;
        const updatedAt = wallTime(e.updatedAt);
        if (updatedAt && (!maxUpdated || updatedAt > maxUpdated)) maxUpdated = updatedAt;
        const facilityId = siteByOu.get(e.orgUnit);
        if (!facilityId) {
          stats.unmappedEvents += 1;
          stats.unmappedOrgUnits[e.orgUnit] = (stats.unmappedOrgUnits[e.orgUnit] || 0) + 1;
          continue;
        }
        const day = visitDay(e.occurredAt);
        const occurredAt = dayAsDate(day);
        const dv = e.dataValues.find((d) => d.dataElement === config.dispenseDataElementId);
        const counts = !e.deleted && statuses.has(String(e.status || "").toUpperCase()) && (!startDay || !day || day >= startDay);
        const target = counts ? toInt(dv?.value) : 0;

        await prisma.$transaction(async (tx) => {
          let imp = await tx.dhis2EventImport.findUnique({ where: { eventUid: e.event } });
          if (!imp) {
            if (target === 0) {
              stats.unchanged += 1;
              return;
            }
            imp = await tx.dhis2EventImport.create({
              data: { eventUid: e.event, implementationId, orgUnitId: e.orgUnit, facilityId, occurredAt, dhis2UpdatedAt: updatedAt, status: e.status, deleted: e.deleted },
            });
          }
          if (imp.facilityId && imp.facilityId !== facilityId && imp.reportedSachets > 0) {
            // Event moved to another org unit: give back at the old site first.
            const back = await applyTarget(tx, imp, { target: 0, facilityId: imp.facilityId, productId: config.dispenseProductId, occurredAt });
            imp = await tx.dhis2EventImport.update({ where: { id: imp.id }, data: { ...back, delta: undefined, facilityId } });
          }
          if (imp.reportedSachets === target && imp.facilityId === facilityId) {
            await tx.dhis2EventImport.update({ where: { id: imp.id }, data: { dhis2UpdatedAt: updatedAt, status: e.status, deleted: e.deleted } });
            stats.unchanged += 1;
            return;
          }
          const before = imp.shortfallSachets;
          const r = await applyTarget(tx, imp, { target, facilityId, productId: config.dispenseProductId, occurredAt });
          await tx.dhis2EventImport.update({
            where: { id: imp.id },
            data: {
              reportedSachets: r.reportedSachets,
              deductedSachets: r.deductedSachets,
              shortfallSachets: r.shortfallSachets,
              facilityId,
              orgUnitId: e.orgUnit,
              occurredAt,
              dhis2UpdatedAt: updatedAt,
              status: e.status,
              deleted: e.deleted,
            },
          });
          stats.applied += 1;
          if (r.delta > 0) stats.sachetsDeducted += r.delta - Math.max(0, r.shortfallSachets - before);
          if (r.delta < 0) stats.sachetsReturned += -r.delta;
          if (r.shortfallSachets > before) stats.newShortfall += r.shortfallSachets - before;
        });
      }
      if (!more) break;
    }

    // Settle earlier shortfalls where stock is now available.
    const open = await prisma.dhis2EventImport.findMany({
      where: { implementationId, shortfallSachets: { gt: 0 }, facilityId: orgUnit ? siteByOu.get(orgUnit) : { not: null } },
      orderBy: { occurredAt: "asc" },
      take: 2000,
    });
    for (const imp of open) {
      await prisma.$transaction(async (tx) => {
        const taken = await deduct(tx, { facilityId: imp.facilityId, productId: config.dispenseProductId, sachets: imp.shortfallSachets, eventImportId: imp.id, occurredAt: imp.occurredAt });
        if (taken > 0) {
          await tx.dhis2EventImport.update({
            where: { id: imp.id },
            data: { shortfallSachets: { decrement: taken }, deductedSachets: { increment: taken } },
          });
          stats.settledShortfall += taken;
        }
      });
    }

    if (!orgUnit) {
      await prisma.dhis2Config.update({ where: { implementationId }, data: { pullCursor: maxUpdated || serverNow || config.pullCursor, lastPullAt: new Date() } });
    }
    await finishRun(run, "SUCCESS", stats);
    return { ok: true, stats };
  } catch (err) {
    await finishRun(run, "FAILED", stats, err.message || err);
    return { ok: false, error: err.message || String(err), stats };
  } finally {
    running.delete(key);
  }
}

// ---------------------------------------------------------------------------
// PUSH
// ---------------------------------------------------------------------------
// `d` is a wall-clock date stored as UTC (see wallTime), normally DHIS2's own
// date: DHIS2 refuses periods after its today.
function periodFor(type, d) {
  const pad = (n) => String(n).padStart(2, "0");
  if (!d) {
    const now = new Date();
    d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  }
  if (type === "Monthly") return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;
  if (type === "Weekly") {
    // ISO week
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${t.getUTCFullYear()}W${week}`;
  }
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

async function stockSnapshot(implementationId, productIds, facilityId = null) {
  const sites = await prisma.facility.findMany({
    where: { implementationId, dhis2OrgUnitId: { not: null }, ...(facilityId ? { id: facilityId } : {}) },
    select: { id: true, name: true, dhis2OrgUnitId: true },
  });
  const rows = await prisma.box.groupBy({
    by: ["currentFacilityId", "productId"],
    where: { currentFacilityId: { in: sites.map((s) => s.id) }, productId: { in: productIds }, status: { in: ["IN_FACILITY", "IN_WAREHOUSE"] }, sachetsRemaining: { gt: 0 } },
    _count: { _all: true },
    _sum: { sachetsRemaining: true },
  });
  const map = new Map(rows.map((r) => [`${r.currentFacilityId}|${r.productId}`, { boxes: r._count._all, sachets: r._sum.sachetsRemaining || 0 }]));
  return { sites, get: (siteId, productId) => map.get(`${siteId}|${productId}`) || { boxes: 0, sachets: 0 } };
}

// Org units each data element can receive values for (via its data sets).
// null when DHIS2 cannot tell us; then everything is sent and DHIS2 decides.
async function assignedOrgUnits(dataElementIds) {
  try {
    const out = new Map();
    for (const id of dataElementIds) {
      const d = await client.request(`dataElements/${encodeURIComponent(id)}`, { query: { fields: "dataSetElements[dataSet[organisationUnits[id]]]" } });
      out.set(id, new Set((d.dataSetElements || []).flatMap((x) => (x.dataSet?.organisationUnits || []).map((o) => o.id))));
    }
    return out;
  } catch {
    return null;
  }
}

async function push(implementationId, { trigger = "SCHEDULE", facilityId = null } = {}) {
  const key = `push:${implementationId}`;
  if (running.has(key)) return { skipped: "A push is already running" };
  running.add(key);
  const run = await startRun(implementationId, facilityId ? "PUSH_SITE" : "PUSH", trigger);
  const stats = { sites: 0, values: 0, imported: 0, updated: 0, ignored: 0, conflicts: [], notAssigned: [] };
  try {
    const config = await prisma.dhis2Config.findUnique({ where: { implementationId }, include: { stockElements: true } });
    const elements = (config?.stockElements || []).filter((e) => e.boxesDataElementId || e.sachetsDataElementId);
    if (!elements.length) throw new Error("No stock data elements configured");
    const period = periodFor(config.stockPeriodType, await serverWallNow());
    const snap = await stockSnapshot(implementationId, elements.map((e) => e.productId), facilityId);
    if (facilityId && !snap.sites.length) throw new Error("That site is not linked to a DHIS2 org unit");
    stats.sites = snap.sites.length;
    stats.period = period;
    if (facilityId) stats.site = snap.sites[0].name;
    const deIds = [...new Set(elements.flatMap((e) => [e.boxesDataElementId, e.sachetsDataElementId]).filter(Boolean))];
    const assigned = await assignedOrgUnits(deIds);
    const dataValues = [];
    const skipped = new Set();
    for (const site of snap.sites) {
      for (const el of elements) {
        const s = snap.get(site.id, el.productId);
        const add = (de, value) => {
          if (!de) return;
          if (assigned && !assigned.get(de)?.has(site.dhis2OrgUnitId)) {
            skipped.add(site.name);
            return;
          }
          dataValues.push({ dataElement: de, period, orgUnit: site.dhis2OrgUnitId, value: String(value) });
        };
        add(el.boxesDataElementId, s.boxes);
        add(el.sachetsDataElementId, s.sachets);
      }
    }
    stats.notAssigned = [...skipped].sort();
    stats.values = dataValues.length;
    if (!dataValues.length) {
      throw new Error(
        stats.notAssigned.length
          ? `Not assigned in DHIS2: the data set holding the stock data elements does not include ${stats.notAssigned.slice(0, 5).join(", ")}${stats.notAssigned.length > 5 ? "…" : ""}`
          : "Nothing to send"
      );
    }
    for (let i = 0; i < dataValues.length; i += 1000) {
      const r = await client.postDataValues(dataValues.slice(i, i + 1000));
      const res = r?.response || r || {};
      const c = res.importCount || {};
      stats.imported += c.imported || 0;
      stats.updated += c.updated || 0;
      stats.ignored += c.ignored || 0;
      for (const cf of res.conflicts || []) if (stats.conflicts.length < 20) stats.conflicts.push(cf.value || cf.object || JSON.stringify(cf));
    }
    await prisma.dhis2Config.update({ where: { implementationId }, data: { lastPushAt: new Date() } });
    const saved = stats.imported + stats.updated;
    const status = !saved && stats.ignored ? "FAILED" : stats.conflicts.length || stats.ignored || stats.notAssigned.length ? "PARTIAL" : "SUCCESS";
    await finishRun(
      run,
      status,
      stats,
      status === "FAILED"
        ? `DHIS2 refused every value: ${stats.conflicts[0] || "see conflicts"}`
        : stats.notAssigned.length
        ? `${stats.notAssigned.length} site(s) skipped: not assigned to the stock data set in DHIS2`
        : null
    );
    if (status === "FAILED") return { ok: false, error: `DHIS2 refused every value: ${stats.conflicts[0] || "see conflicts"}`, stats };
    return { ok: status !== "FAILED", stats };
  } catch (err) {
    await finishRun(run, "FAILED", stats, err.message || err);
    return { ok: false, error: err.message || String(err), stats };
  } finally {
    running.delete(key);
  }
}

// Scheduler: every few minutes, sync implementations whose interval has passed.
function startScheduler() {
  if (!client.isConfigured()) {
    console.log("DHIS2 sync: not configured (DHIS2_URL / DHIS2_TOKEN); scheduler idle");
  }
  const tick = async () => {
    if (!client.isConfigured()) return;
    try {
      const configs = await prisma.dhis2Config.findMany({ where: { enabled: true } });
      for (const c of configs) {
        const due = !c.lastPullAt || Date.now() - c.lastPullAt.getTime() >= c.intervalMinutes * 60000;
        if (!due) continue;
        await pull(c.implementationId);
        await push(c.implementationId);
      }
      // Children from tracker programs (OTP, ...), on the same interval.
      await require("./tracker").syncDueTrackerPrograms();
    } catch (err) {
      console.error("DHIS2 scheduler:", err.message || err);
    }
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 30 * 1000).unref?.();
}

const isRunning = (implementationId) => running.has(`pull:${implementationId}`) || running.has(`push:${implementationId}`);

module.exports = { pull, push, periodFor, serverWallNow, wallTime, visitDay, dayAsDate, stockSnapshot, startScheduler, isRunning, applyTarget, deduct, giveBack };
