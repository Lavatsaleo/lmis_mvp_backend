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
  lastWeightKg: true,
  lastMuacCm: true,
  lastWhz: true,
  enrollmentUid: true,
  trackedEntityUid: true,
};

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
      lines.push(["Program", "Site", "Payam", "County", "Patient ID", "Child name", "Sex", "Caregiver", "Visit type", "Status", "Date", "Scheduled", "Weight (kg)", "Height (cm)", "MUAC (cm)", "WHZ", "Oedema", "Sachets", "Nutrition status", "Visit status", "Next visit", "Outcome"].join(","));
      for (const c of children) {
        for (const v of c.visits) {
          lines.push(
            [c.programConfig.code, c.orgUnitName, c.orgUnitParentName, c.countyName, c.patientId, c.childName, c.sex, c.caregiverName, v.stage, v.status, v.occurredAt, v.scheduledAt, v.weightKg, v.heightCm, v.muacCm, v.whz, v.oedema, v.sachets, v.nutritionStatus, v.visitStatus, v.nextVisitDate, v.outcome]
              .map(csvCell)
              .join(",")
          );
        }
      }
    } else {
      lines.push(["Program", "Site", "Payam", "County", "Patient ID", "Child name", "Sex", "Date of birth", "Age at admission (months)", "Caregiver", "Payam (address)", "Village/Boma", "Admitted", "Admission type", "Visits", "Last visit", "Next visit", "Status", "Outcome date", "Sachets given", "Last weight (kg)", "Last MUAC (cm)", "Last WHZ"].join(","));
      for (const c of children) {
        lines.push(
          [c.programConfig.code, c.orgUnitName, c.orgUnitParentName, c.countyName, c.patientId, c.childName, c.sex, c.dateOfBirth, c.ageMonths, c.caregiverName, c.addressPayam, c.addressVillage, c.enrolledAt, c.admissionType, c.visitCount, c.lastVisitDate, c.nextVisitDate, statusOf(c), c.outcomeDate, c.sachetsTotal, c.lastWeightKg, c.lastMuacCm, c.lastWhz]
            .map(csvCell)
            .join(",")
        );
      }
    }
    await audit(req, {
      action: "CHILDREN_EXPORTED",
      targetType: "IMPLEMENTATION",
      target: { id: req.query.implementationId || req.user.implementationId || "all", name: "DHIS2 children" },
      details: { level: visitsLevel ? "visits" : "children", children: children.length, filters: req.query },
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="children-${visitsLevel ? "visits" : "list"}-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM so Excel opens names with accents correctly.
    return res.send("﻿" + lines.join("\r\n"));
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
