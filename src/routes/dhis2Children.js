// Children copied from DHIS2 tracker programs (OTP, ...), for support officers
// comparing patient-level data with facility registers. Read-only.
//
//   GET /api/dhis2-children/programs?implementationId=
//   GET /api/dhis2-children/sites?implementationId=&programId=
//   GET /api/dhis2-children?programId=&orgUnit=&status=&q=&enrolledFrom=&enrolledTo=&visitFrom=&visitTo=&page=&pageSize=
//   GET /api/dhis2-children/export.csv?...same filters...&level=children|visits
//   GET /api/dhis2-children/:id

const express = require("express");

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { isSuperAdmin, countryWideImplementationId, locationWithDescendants } = require("../auth/access");
const { audit } = require("../auth/audit");
const { optionName } = require("../dhis2/tracker");
const { siteMatcher } = require("../dhis2/siteMatch");
const { Prisma } = require("@prisma/client");

const router = express.Router();
router.use(requireAuth);

const DAY = 86400000;
const startOfTodayUtc = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** What this user may see: a where-fragment, or null for nothing. */
async function childScope(req) {
  const u = req.user;
  if (isSuperAdmin(u)) return req.query.implementationId ? { implementationId: String(req.query.implementationId) } : {};
  const countryId = countryWideImplementationId(u);
  if (countryId) return { implementationId: countryId };
  if (u.facilityType === "WAREHOUSE" && u.facilityId) {
    return { facilityId: { in: await locationWithDescendants(u.facilityId) } };
  }
  if (u.facilityId && ["FACILITY_OFFICER", "VIEWER"].includes(u.role)) return { facilityId: u.facilityId };
  return null;
}

const dayStart = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(`${v}T00:00:00Z`) : null);
const dayEnd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(`${v}T23:59:59.999Z`) : null);

/** Status filters, in plain words. */
function statusWhere(status) {
  const today = startOfTodayUtc();
  switch (String(status || "").toUpperCase()) {
    case "IN_TREATMENT":
      return { outcome: null, enrollmentStatus: "ACTIVE" };
    case "MISSED":
      return { outcome: null, enrollmentStatus: "ACTIVE", nextVisitDate: { lt: today } };
    case "DISCHARGED":
      return { OR: [{ outcome: { not: null } }, { enrollmentStatus: "COMPLETED" }] };
    case "CANCELLED":
      return { enrollmentStatus: "CANCELLED" };
    case "":
      return {};
    default:
      return { outcome: String(status) };
  }
}

async function buildWhere(req) {
  const scope = await childScope(req);
  if (!scope) return null;
  const q = req.query;
  const and = [{ deleted: false }, scope];
  if (q.programId) and.push({ programConfigId: String(q.programId) });
  if (q.orgUnit) and.push({ orgUnitUid: String(q.orgUnit) });
  if (q.status) and.push(statusWhere(q.status));
  const ef = dayStart(q.enrolledFrom);
  const et = dayEnd(q.enrolledTo);
  if (ef || et) and.push({ enrolledAt: { ...(ef ? { gte: ef } : {}), ...(et ? { lte: et } : {}) } });
  const vf = dayStart(q.visitFrom);
  const vt = dayEnd(q.visitTo);
  if (vf || vt) {
    and.push({ visits: { some: { deleted: false, status: { in: ["ACTIVE", "COMPLETED"] }, occurredAt: { ...(vf ? { gte: vf } : {}), ...(vt ? { lte: vt } : {}) } } } });
  }
  const term = String(q.q || "").trim();
  if (term) and.push({ OR: [{ childName: { contains: term } }, { patientId: { contains: term } }, { caregiverName: { contains: term } }] });
  return { AND: and };
}

const childSelect = {
  id: true,
  programConfigId: true,
  patientId: true,
  childName: true,
  caregiverName: true,
  sex: true,
  dateOfBirth: true,
  ageMonths: true,
  addressPayam: true,
  addressVillage: true,
  orgUnitUid: true,
  orgUnitName: true,
  orgUnitParentName: true,
  countyName: true,
  facilityId: true,
  enrolledAt: true,
  enrollmentStatus: true,
  admissionType: true,
  outcome: true,
  outcomeDate: true,
  visitCount: true,
  lastVisitDate: true,
  nextVisitDate: true,
  sachetsTotal: true,
  commodityTotals: true,
  lastWeightKg: true,
  lastMuacCm: true,
  lastWhz: true,
  enrollmentUid: true,
  trackedEntityUid: true,
};

/** "RUTF 130 sachets · CSB++ 4.5 kg" */
const givenText = (items) => (items || []).map((g) => `${g.commodity} ${Number(g.amount).toLocaleString("en")} ${g.unit}`).join(" · ");

/** Plain status of one child for the list. */
function statusOf(c) {
  if (c.outcome) return c.outcome;
  if (c.enrollmentStatus === "CANCELLED") return "Cancelled";
  if (c.enrollmentStatus === "COMPLETED") return "Discharged";
  if (c.nextVisitDate && c.nextVisitDate < startOfTodayUtc()) return "Missed appointment";
  return "In treatment";
}

const fail = (res, err) => {
  console.error(err);
  return res.status(500).json({ message: "Server error", error: String(err.message || err) });
};

router.get("/programs", async (req, res) => {
  try {
    const scope = await childScope(req);
    if (!scope) return res.json([]);
    const implWhere = scope.implementationId ? { implementationId: scope.implementationId } : isSuperAdmin(req.user) ? {} : { implementationId: req.user.implementationId || "__none__" };
    const programs = await prisma.dhis2TrackerProgram.findMany({ where: implWhere, orderBy: { code: "asc" } });
    const counts = await prisma.dhis2Child.groupBy({ by: ["programConfigId"], where: { AND: [{ deleted: false }, scope] }, _count: { _all: true } });
    const byProgram = new Map(counts.map((c) => [c.programConfigId, c._count._all]));
    return res.json(
      programs
        .filter((p) => p.enabled || byProgram.get(p.id))
        .map((p) => ({ id: p.id, implementationId: p.implementationId, code: p.code, name: p.name, commodity: p.commodity, children: byProgram.get(p.id) || 0, lastPullAt: p.lastPullAt, startDate: p.startDate }))
    );
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/sites", async (req, res) => {
  try {
    const scope = await childScope(req);
    if (!scope) return res.json([]);
    const where = { AND: [{ deleted: false }, scope, ...(req.query.programId ? [{ programConfigId: String(req.query.programId) }] : [])] };
    const rows = await prisma.dhis2Child.groupBy({
      by: ["orgUnitUid", "orgUnitName", "orgUnitParentName", "countyName", "facilityId"],
      where,
      _count: { _all: true },
    });
    return res.json(
      rows
        .map((r) => ({ orgUnitUid: r.orgUnitUid, name: r.orgUnitName, payam: r.orgUnitParentName, county: r.countyName, inAnchor: !!r.facilityId, children: r._count._all }))
        .sort((a, b) => String(a.county || "").localeCompare(String(b.county || "")) || String(a.name).localeCompare(String(b.name)))
    );
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/", async (req, res) => {
  try {
    const where = await buildWhere(req);
    if (!where) return res.status(403).json({ message: "Your account cannot view children" });
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const today = startOfTodayUtc();
    const [total, rows, sachets, inTreatment, missed, outcomes] = await Promise.all([
      prisma.dhis2Child.count({ where }),
      prisma.dhis2Child.findMany({
        where,
        select: childSelect,
        orderBy: [{ enrolledAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.dhis2Child.aggregate({ where, _sum: { sachetsTotal: true, visitCount: true } }),
      prisma.dhis2Child.count({ where: { AND: [where, { outcome: null, enrollmentStatus: "ACTIVE" }] } }),
      prisma.dhis2Child.count({ where: { AND: [where, { outcome: null, enrollmentStatus: "ACTIVE", nextVisitDate: { lt: today } }] } }),
      prisma.dhis2Child.groupBy({ by: ["outcome"], where: { AND: [where, { outcome: { not: null } }] }, _count: { _all: true } }),
    ]);
    const vf = dayStart(req.query.visitFrom);
    const vt = dayEnd(req.query.visitTo);
    const givenRows = await prisma.dhis2VisitCommodity.groupBy({
      by: ["commodity", "unit"],
      where: { child: where, ...(vf || vt ? { occurredAt: { ...(vf ? { gte: vf } : {}), ...(vt ? { lte: vt } : {}) } } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
    });
    return res.json({
      total,
      page,
      pageSize,
      rows: rows.map((c) => ({ ...c, status: statusOf(c) })),
      summary: {
        children: total,
        inTreatment,
        missed,
        discharged: outcomes.reduce((n, o) => n + o._count._all, 0),
        outcomes: outcomes.map((o) => ({ outcome: o.outcome, children: o._count._all })).sort((a, b) => b.children - a.children),
        sachets: sachets._sum.sachetsTotal || 0,
        visits: sachets._sum.visitCount || 0,
        // Given, per commodity and unit (units are never added together).
        given: givenRows
          .map((g) => ({ commodity: g.commodity, unit: g.unit, amount: Math.round((g._sum.amount || 0) * 100) / 100, visits: g._count._all }))
          .sort((a, b) => a.commodity.localeCompare(b.commodity)),
      },
    });
  } catch (err) {
    return fail(res, err);
  }
});

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Exports carry no personal identifiers: only the Patient ID identifies a child
// (no child or caregiver names, date of birth or home address). Names stay on
// screen, for register checks, but never leave Anchor in a file.
router.get("/export.csv", async (req, res) => {
  try {
    const where = await buildWhere(req);
    if (!where) return res.status(403).json({ message: "Your account cannot view children" });
    const visitsLevel = req.query.level === "visits";
    const children = await prisma.dhis2Child.findMany({
      where,
      select: { ...childSelect, programConfig: { select: { code: true, commodity: true } }, ...(visitsLevel ? { visits: { where: { deleted: false }, orderBy: { occurredAt: "asc" } } } : {}) },
      orderBy: [{ orgUnitName: "asc" }, { enrolledAt: "asc" }],
      take: 50000,
    });
    const lines = [];
    if (visitsLevel) {
      lines.push(["Program", "Site", "Payam", "County", "Patient ID", "Sex", "Age at admission (months)", "Visit type", "Status", "Date", "Scheduled", "Weight (kg)", "Height (cm)", "MUAC (cm)", "WHZ", "Oedema", "Treatment given", "Commodity", "Amount", "Unit", "Nutrition status", "Visit status", "Next visit", "Outcome"].join(","));
      for (const c of children) {
        for (const v of c.visits) {
          lines.push(
            [c.programConfig.code, c.orgUnitName, c.orgUnitParentName, c.countyName, c.patientId, c.sex, c.ageMonths, v.stage, v.status, v.occurredAt, v.scheduledAt, v.weightKg, v.heightCm, v.muacCm, v.whz, v.oedema, v.treatment, (v.commodities || [])[0]?.commodity, (v.commodities || [])[0]?.amount, (v.commodities || [])[0]?.unit, v.nutritionStatus, v.visitStatus, v.nextVisitDate, v.outcome]
              .map(csvCell)
              .join(",")
          );
        }
      }
    } else {
      lines.push(["Program", "Site", "Payam", "County", "Patient ID", "Sex", "Age at admission (months)", "Admitted", "Admission type", "Visits", "Last visit", "Next visit", "Status", "Outcome date", "Given in total", "Last weight (kg)", "Last MUAC (cm)", "Last WHZ"].join(","));
      for (const c of children) {
        lines.push(
          [c.programConfig.code, c.orgUnitName, c.orgUnitParentName, c.countyName, c.patientId, c.sex, c.ageMonths, c.enrolledAt, c.admissionType, c.visitCount, c.lastVisitDate, c.nextVisitDate, statusOf(c), c.outcomeDate, givenText(c.commodityTotals), c.lastWeightKg, c.lastMuacCm, c.lastWhz]
            .map(csvCell)
            .join(",")
        );
      }
    }
    await audit(req, {
      action: "CHILDREN_EXPORTED",
      targetType: "IMPLEMENTATION",
      target: { id: req.query.implementationId || req.user.implementationId || "all", name: "DHIS2 children" },
      details: { level: visitsLevel ? "visits" : "children", children: children.length, filters: { ...req.query, q: req.query.q ? "(search)" : undefined } },
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="children-${visitsLevel ? "visits" : "list"}-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM so Excel opens names with accents correctly.
    return res.send("﻿" + lines.join("\r\n"));
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/dhis2-children/map?implementationId=&programIds=a,b&from=&to=
// Workload and results per site for the programme map: admissions in the
// period, children in treatment now, discharges by outcome in the period and
// commodities given in the period, with each site's coordinates.
// ---------------------------------------------------------------------------
const OUTCOME_GROUPS = [
  ["cured", /cured|recovered/i],
  ["died", /died|death|dead/i],
  ["defaulted", /default/i],
  ["nonResponse", /non.?respon/i],
];
const outcomeGroup = (o) => OUTCOME_GROUPS.find(([, re]) => re.test(String(o || "")))?.[0] || "otherExits";

router.get("/map", async (req, res) => {
  try {
    const scope = await childScope(req);
    if (!scope) return res.status(403).json({ message: "Your account cannot view children" });
    const implWhere = scope.implementationId ? { implementationId: scope.implementationId } : isSuperAdmin(req.user) ? {} : { implementationId: req.user.implementationId || "__none__" };
    const programs = await prisma.dhis2TrackerProgram.findMany({ where: implWhere, select: { id: true, code: true, name: true, implementationId: true }, orderBy: { code: "asc" } });
    const wanted = String(req.query.programIds || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const programIds = wanted.length ? programs.filter((p) => wanted.includes(p.id)).map((p) => p.id) : programs.map((p) => p.id);
    const from = dayStart(req.query.from);
    const to = dayEnd(req.query.to);
    const inPeriod = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : null;
    const base = { AND: [{ deleted: false }, scope, { programConfigId: { in: programIds } }] };
    const today = startOfTodayUtc();

    const by = ["orgUnitUid", "programConfigId"];
    const [meta, admissions, active, missed, exits] = await Promise.all([
      prisma.dhis2Child.groupBy({ by: ["orgUnitUid", "orgUnitName", "orgUnitParentName", "countyName", "facilityId"], where: base, _count: { _all: true } }),
      prisma.dhis2Child.groupBy({ by, where: { AND: [base, ...(inPeriod ? [{ enrolledAt: inPeriod }] : [])] }, _count: { _all: true } }),
      prisma.dhis2Child.groupBy({ by, where: { AND: [base, { outcome: null, enrollmentStatus: "ACTIVE" }] }, _count: { _all: true } }),
      prisma.dhis2Child.groupBy({ by, where: { AND: [base, { outcome: null, enrollmentStatus: "ACTIVE", nextVisitDate: { lt: today } }] }, _count: { _all: true } }),
      prisma.dhis2Child.groupBy({ by: [...by, "outcome"], where: { AND: [base, { outcome: { not: null } }, ...(inPeriod ? [{ outcomeDate: inPeriod }] : [])] }, _count: { _all: true } }),
    ]);

    // Commodities given in the period, per site and program.
    const scopeSql = [];
    if (scope.implementationId) scopeSql.push(Prisma.sql`c.implementationId = ${scope.implementationId}`);
    if (scope.facilityId?.in) scopeSql.push(scope.facilityId.in.length ? Prisma.sql`c.facilityId IN (${Prisma.join(scope.facilityId.in)})` : Prisma.sql`1 = 0`);
    else if (typeof scope.facilityId === "string") scopeSql.push(Prisma.sql`c.facilityId = ${scope.facilityId}`);
    const given = programIds.length
      ? await prisma.$queryRaw`
          SELECT c.orgUnitUid AS orgUnitUid, c.programConfigId AS programConfigId, g.commodity AS commodity, g.unit AS unit, SUM(g.amount) AS amount
          FROM \`Dhis2VisitCommodity\` g JOIN \`Dhis2Child\` c ON c.id = g.childId
          WHERE c.deleted = false AND c.programConfigId IN (${Prisma.join(programIds)})
            ${scopeSql.length ? Prisma.sql`AND ${Prisma.join(scopeSql, " AND ")}` : Prisma.empty}
            ${from ? Prisma.sql`AND g.occurredAt >= ${from}` : Prisma.empty}
            ${to ? Prisma.sql`AND g.occurredAt <= ${to}` : Prisma.empty}
          GROUP BY c.orgUnitUid, c.programConfigId, g.commodity, g.unit`
      : [];

    // Coordinates from the GPS list, matched by name.
    const implIds = [...new Set(programs.map((p) => p.implementationId))];
    const mapSites = await prisma.mapSite.findMany({ where: { implementationId: { in: implIds.length ? implIds : [scope.implementationId || "__none__"] } } });
    const match = siteMatcher(mapSites);

    const sites = new Map();
    for (const m of meta) {
      const prev = sites.get(m.orgUnitUid);
      if (prev) continue;
      const loc = match(m.orgUnitName, m.countyName);
      sites.set(m.orgUnitUid, {
        key: m.orgUnitUid,
        name: m.orgUnitName,
        payam: m.orgUnitParentName,
        county: (m.countyName || loc?.county || "").replace(/\s+county$/i, "") || null,
        state: loc?.state || null,
        latitude: loc?.latitude ?? null,
        longitude: loc?.longitude ?? null,
        gpsName: loc?.name || null,
        issues: loc?.issues || null,
        inAnchor: !!m.facilityId,
        programs: {},
        given: [],
      });
    }
    const slot = (orgUnitUid, programConfigId) => {
      const site = sites.get(orgUnitUid);
      if (!site) return null;
      site.programs[programConfigId] = site.programs[programConfigId] || { admissions: 0, inTreatment: 0, missed: 0, cured: 0, died: 0, defaulted: 0, nonResponse: 0, otherExits: 0 };
      return site.programs[programConfigId];
    };
    for (const r of admissions) { const x = slot(r.orgUnitUid, r.programConfigId); if (x) x.admissions = r._count._all; }
    for (const r of active) { const x = slot(r.orgUnitUid, r.programConfigId); if (x) x.inTreatment = r._count._all; }
    for (const r of missed) { const x = slot(r.orgUnitUid, r.programConfigId); if (x) x.missed = r._count._all; }
    for (const r of exits) { const x = slot(r.orgUnitUid, r.programConfigId); if (x) x[outcomeGroup(r.outcome)] += r._count._all; }
    for (const r of given) {
      const site = sites.get(r.orgUnitUid);
      if (site) site.given.push({ programConfigId: r.programConfigId, commodity: r.commodity, unit: r.unit, amount: Math.round(Number(r.amount) * 100) / 100 });
    }

    // GPS-list sites with no records yet (country-wide views only).
    const usedGps = new Set([...sites.values()].map((x) => x.gpsName).filter(Boolean));
    const countryWide = !scope.facilityId;
    const idleSites = countryWide
      ? mapSites.filter((m) => !usedGps.has(m.name)).map((m) => ({ name: m.name, state: m.state, county: m.county, payam: m.payam, latitude: m.latitude, longitude: m.longitude, issues: m.issues }))
      : [];

    return res.json({
      period: { from: req.query.from || null, to: req.query.to || null },
      programs: programs.map(({ id, code, name }) => ({ id, code, name, selected: programIds.includes(id) })),
      sites: [...sites.values()],
      idleSites,
      gpsIssues: countryWide ? mapSites.filter((m) => Array.isArray(m.issues) && m.issues.length).map((m) => ({ name: m.name, county: m.county, issues: m.issues })) : [],
    });
  } catch (err) {
    return fail(res, err);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const scope = await childScope(req);
    if (!scope) return res.status(403).json({ message: "Your account cannot view children" });
    const child = await prisma.dhis2Child.findFirst({
      where: { AND: [{ id: String(req.params.id), deleted: false }, scope] },
      select: {
        ...childSelect,
        programConfig: { select: { code: true, name: true, commodity: true, labels: true, mapping: true } },
        visits: { where: { deleted: false }, orderBy: [{ occurredAt: "asc" }, { scheduledAt: "asc" }] },
      },
    });
    if (!child) return res.status(404).json({ message: "Child not found" });
    const { labels, mapping, ...program } = child.programConfig;
    const deNames = labels?.dataElements || {};
    const stageNames = labels?.stages || {};
    return res.json({
      ...child,
      status: statusOf(child),
      programConfig: program,
      visits: child.visits.map((v) => ({
        ...v,
        stageName: stageNames[v.programStageUid] || v.stage,
        // Every recorded field with its DHIS2 name, for register comparison.
        fields: Object.entries(v.dataValues || {})
          .map(([id, value]) => ({ name: deNames[id] || id, value: optionName(labels, id, value) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        dataValues: undefined,
      })),
      mappingFound: Object.keys(mapping?.dataElements || {}),
    });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
