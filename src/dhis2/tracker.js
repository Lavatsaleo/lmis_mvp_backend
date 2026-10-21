// Copy children from a DHIS2 tracker program (OTP, TSFP, ...) into Anchor,
// read-only, for patient-level review against facility registers.
//
// One Dhis2Child per enrolment, one Dhis2ChildVisit per event. The first sync
// reads every enrolment since the program's start date; later syncs read only
// what changed (events, enrolments or the child's details) since the last run.
// Deleted records are marked deleted, never removed.

const prisma = require("../lib/prisma");
const client = require("./client");
const { serverWallNow, wallTime, visitDay, dayAsDate } = require("./sync");

const OVERLAP_MS = 5 * 60 * 1000;
const running = new Set();

// --------------------------------------------------------------------------
// Which DHIS2 fields mean what, found from their names (works for OTP, TSFP,
// SC... without code changes). Each role can list several data elements (e.g.
// sachets on admission and sachets at follow-up); the first with a value wins.
// --------------------------------------------------------------------------
const ATTRIBUTE_ROLES = {
  childName: (n) => /(child|patient|beneficiary).*name|^name$|^full name$/i.test(n) && !/caregiver|mother|guardian/i.test(n),
  patientId: (n) => /patient id|registration (no|number)|unique.*(id|number)|^id$|serial/i.test(n),
  sex: (n) => /gender|^sex$/i.test(n),
  dateOfBirth: (n) => /date of birth|^dob$/i.test(n),
  ageMonths: (n) => /age.*month/i.test(n),
  caregiverName: (n) => /caregiver|mother|guardian/i.test(n) && /name/i.test(n),
  payam: (n) => /payam/i.test(n),
  village: (n) => /village|boma/i.test(n),
};
const STAGE_ROLES = {
  admission: (n) => /admission|enrol/i.test(n),
  followUp: (n) => /follow/i.test(n),
  discharge: (n) => /discharge|exit/i.test(n),
};
const DATA_ELEMENT_ROLES = {
  weight: (n) => /^weight\b/i.test(n) && !/for/i.test(n),
  height: (n) => /^(height|length)\b/i.test(n) && !/for/i.test(n),
  muac: (n) => /muac/i.test(n),
  whz: (n) => /weight[- ]for[- ]height|\bwhz\b/i.test(n),
  oedema: (n) => /oedema|edema/i.test(n),
  sachets: (n) => /sachets?/i.test(n) && /(provided|given|dispensed|distributed)/i.test(n) && !/recommend/i.test(n),
  nextVisit: (n) => /next.*(visit|appointment)/i.test(n),
  visitStatus: (n) => /^visit status/i.test(n),
  nutritionStatus: (n) => /nutrition(al)? status/i.test(n),
  outcome: (n) => /discharge outcome|exit outcome|^outcome$/i.test(n),
  admissionType: (n) => /type of admission|admission type/i.test(n),
  treatment: (n) => /treatment given|commodity given|type of (ration|treatment)/i.test(n),
};

// Mapping format; an older stored mapping is re-detected on the next sync.
const MAPPING_VERSION = 2;

/** Commodity named in a field or answer: RUTF, RUSF, CSB++, SQ-LNS. */
function commodityOf(text) {
  const t = String(text || "");
  if (/rutf/i.test(t)) return "RUTF";
  if (/rusf/i.test(t)) return "RUSF";
  if (/csb/i.test(t)) return "CSB++";
  if (/sq-?lns|\blns\b/i.test(t)) return "SQ-LNS";
  return null;
}
const unitOf = (name) => (/\bkg\b|kilo/i.test(name) ? "kg" : "sachets");
// A field holding an amount given (not the recommended ration).
const isGivenAmount = (name) =>
  /(provided|given|dispensed|distributed)/i.test(name) && !/recommend/i.test(name) && (/sachets?|\bkg\b|kilo|carton/i.test(name) || !!commodityOf(name));

/** Read a tracker program's metadata and work out the mapping. */
async function detectMapping(programId) {
  const p = await client.request(`programs/${encodeURIComponent(programId)}`, {
    query: {
      fields:
        "id,displayName,programType,programTrackedEntityAttributes[trackedEntityAttribute[id,displayName,optionSet[options[code,displayName]]]]," +
        "programStages[id,displayName,sortOrder,programStageDataElements[dataElement[id,displayName,valueType,optionSet[options[code,displayName]]]]]",
    },
  });
  if (p.programType !== "WITH_REGISTRATION") throw new Error(`${p.displayName} is not a tracker program`);

  // Option codes -> names (DHIS2 stores codes, e.g. "reffered_SC" for "Referred to SC").
  const options = {};
  const keepOptions = (id, optionSet) => {
    if (optionSet?.options?.length) options[id] = Object.fromEntries(optionSet.options.map((o) => [o.code, o.displayName]));
  };
  const attributes = {};
  const attrLabels = {};
  for (const { trackedEntityAttribute: a } of p.programTrackedEntityAttributes || []) {
    attrLabels[a.id] = a.displayName;
    keepOptions(a.id, a.optionSet);
    for (const [role, test] of Object.entries(ATTRIBUTE_ROLES)) if (!attributes[role] && test(a.displayName)) attributes[role] = a.id;
  }
  const stages = {};
  const stageLabels = {};
  const dataElements = {};
  const deLabels = {};
  const quantities = [];
  for (const st of (p.programStages || []).sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0))) {
    stageLabels[st.id] = st.displayName;
    for (const [role, test] of Object.entries(STAGE_ROLES)) if (!stages[role] && test(st.displayName)) stages[role] = st.id;
    for (const { dataElement: d } of st.programStageDataElements || []) {
      deLabels[d.id] = d.displayName;
      keepOptions(d.id, d.optionSet);
      // Amount of a commodity given at a visit, with its unit.
      if (["NUMBER", "INTEGER", "INTEGER_POSITIVE", "INTEGER_ZERO_OR_POSITIVE", "TEXT"].includes(d.valueType) && isGivenAmount(d.displayName)) {
        if (!quantities.some((q) => q.id === d.id)) quantities.push({ id: d.id, commodity: commodityOf(d.displayName), unit: unitOf(d.displayName) });
      }
      for (const [role, test] of Object.entries(DATA_ELEMENT_ROLES)) {
        if (test(d.displayName)) {
          dataElements[role] = dataElements[role] || [];
          if (!dataElements[role].includes(d.id)) dataElements[role].push(d.id);
        }
      }
    }
  }
  return {
    program: { id: p.id, name: p.displayName },
    mapping: { version: MAPPING_VERSION, attributes, stages, dataElements, quantities },
    labels: { attributes: attrLabels, stages: stageLabels, dataElements: deLabels, options },
  };
}

/** A stored value as people read it: option names instead of codes (also for multi-select). */
function optionName(labels, id, value) {
  const set = labels?.options?.[id];
  if (!set || value === null || value === undefined || value === "") return value;
  if (set[value] !== undefined) return set[value];
  const parts = String(value).split(",");
  if (parts.length > 1) return parts.map((p) => set[p.trim()] ?? humanCode(p.trim())).join(", ");
  return humanCode(value);
}

// A code that is no longer in the option set ("New_Case", "Transfer_OTP") shown as words.
function humanCode(value) {
  const v = String(value);
  if (!/^[A-Za-z0-9]+(_[A-Za-z0-9]+)+$/.test(v)) return value;
  const words = v.split("_").join(" ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// --------------------------------------------------------------------------
// Reading values
// --------------------------------------------------------------------------
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const dateOnly = (v) => dayAsDate(visitDay(v));
const firstValue = (values, ids) => {
  for (const id of ids || []) {
    const v = values.get(id);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
};
const COUNTED = new Set(["ACTIVE", "COMPLETED"]);

function stageOf(mapping, programStage) {
  const s = mapping.stages || {};
  if (programStage === s.admission) return "ADMISSION";
  if (programStage === s.followUp) return "FOLLOW_UP";
  if (programStage === s.discharge) return "DISCHARGE";
  return "OTHER";
}

/**
 * What was given at a visit: one entry per commodity, with its unit. Where the
 * form asks "Treatment given", only that commodity's amount counts (values
 * left in the other commodities' fields are ignored).
 */
function givenAtVisit(mapping, values, labels, treatment, defaultCommodity) {
  const items = [];
  for (const q of mapping.quantities || []) {
    const raw = values.get(q.id);
    const amount = num(optionName(labels, q.id, raw) ?? raw);
    if (amount === null || amount <= 0) continue;
    const commodity = q.commodity || defaultCommodity || "Sachets";
    if (items.some((i) => i.commodity === commodity && i.unit === q.unit)) continue;
    items.push({ commodity, unit: q.unit, amount });
  }
  const chosen = commodityOf(treatment);
  if (chosen) {
    const match = items.filter((i) => commodityOf(i.commodity) === chosen);
    if (match.length) return match;
  }
  return items;
}

function visitFromEvent(mapping, e, labels, defaultCommodity) {
  const de = mapping.dataElements || {};
  const values = new Map((e.dataValues || []).map((d) => [d.dataElement, d.value]));
  const named = (ids) => {
    for (const id of ids || []) {
      const v = values.get(id);
      if (v !== undefined && v !== null && v !== "") return optionName(labels, id, v);
    }
    return null;
  };
  const treatment = named(de.treatment);
  const given = mapping.quantities ? givenAtVisit(mapping, values, labels, treatment, defaultCommodity) : null;
  const sachets = given
    ? given.filter((g) => g.unit === "sachets").reduce((n, g) => n + g.amount, 0) || null
    : num(firstValue(values, de.sachets));
  return {
    eventUid: e.event,
    stage: stageOf(mapping, e.programStage),
    programStageUid: e.programStage,
    status: e.status || null,
    occurredAt: dateOnly(e.occurredAt),
    scheduledAt: dateOnly(e.scheduledAt),
    weightKg: num(firstValue(values, de.weight)),
    heightCm: num(firstValue(values, de.height)),
    muacCm: num(firstValue(values, de.muac)),
    whz: num(firstValue(values, de.whz)),
    oedema: named(de.oedema),
    sachets: sachets === null ? null : Math.round(sachets),
    treatment,
    commodities: given && given.length ? given : null,
    nutritionStatus: named(de.nutritionStatus),
    visitStatus: named(de.visitStatus),
    nextVisitDate: dateOnly(firstValue(values, de.nextVisit)),
    outcome: named(de.outcome),
    dataValues: Object.fromEntries(values),
    deleted: !!e.deleted,
    dhis2UpdatedAt: wallTime(e.updatedAt),
  };
}

/** The child's summary from its visits (what the list and reports show). */
function summarise(mapping, enrollment, visits, dob, ageAttr, labels) {
  const live = visits.filter((v) => !v.deleted);
  const done = live.filter((v) => COUNTED.has(String(v.status || "").toUpperCase()) && v.occurredAt);
  const treatment = done.filter((v) => v.stage === "ADMISSION" || v.stage === "FOLLOW_UP" || v.stage === "OTHER");
  const byDate = [...treatment].sort((a, b) => a.occurredAt - b.occurredAt);
  const last = byDate[byDate.length - 1] || null;
  const latestWith = (k) => [...byDate].reverse().find((v) => v[k] !== null && v[k] !== undefined)?.[k] ?? null;
  const discharge = done.filter((v) => v.stage === "DISCHARGE").sort((a, b) => b.occurredAt - a.occurredAt)[0] || null;
  const admission = live.find((v) => v.stage === "ADMISSION") || null;
  const enrolledAt = dateOnly(enrollment.enrolledAt);

  // Next visit: the appointment given at the latest visit, or an appointment
  // scheduled after it. Old appointments that were never used are ignored.
  let nextVisitDate = null;
  if (!discharge && String(enrollment.status || "").toUpperCase() === "ACTIVE") {
    const after = last?.occurredAt || null;
    const candidates = [
      last?.nextVisitDate || null,
      ...live.filter((v) => String(v.status).toUpperCase() === "SCHEDULE" && v.scheduledAt).map((v) => v.scheduledAt),
    ].filter((d) => d && (!after || d >= after));
    nextVisitDate = candidates.sort((a, b) => a - b)[0] || null;
  }
  let ageMonths = ageAttr !== null && ageAttr !== undefined ? Math.round(ageAttr) : null;
  if (ageMonths === null && dob && enrolledAt) {
    ageMonths = Math.max(0, Math.floor((enrolledAt - dob) / (30.4375 * 86400000)));
  }
  return {
    enrolledAt,
    enrollmentStatus: enrollment.status || null,
    admissionType: admission ? visitFromEventValue(admission, mapping, "admissionType", labels) : null,
    outcome: discharge?.outcome || null,
    outcomeDate: discharge?.occurredAt || (String(enrollment.status).toUpperCase() === "COMPLETED" ? dateOnly(enrollment.completedAt) : null),
    visitCount: treatment.length,
    lastVisitDate: last?.occurredAt || null,
    nextVisitDate,
    sachetsTotal: treatment.reduce((n, v) => n + (v.sachets || 0), 0),
    commodityTotals: totalsOf(treatment),
    lastWeightKg: latestWith("weightKg"),
    lastMuacCm: latestWith("muacCm"),
    lastWhz: latestWith("whz"),
    ageMonths,
  };
}
/** Given in total, per commodity and unit, over counted visits. */
function totalsOf(visits) {
  const map = new Map();
  for (const v of visits) {
    for (const g of v.commodities || []) {
      const key = `${g.commodity}|${g.unit}`;
      map.set(key, { commodity: g.commodity, unit: g.unit, amount: (map.get(key)?.amount || 0) + g.amount });
    }
  }
  return [...map.values()].map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100 })).sort((a, b) => a.commodity.localeCompare(b.commodity));
}

function visitFromEventValue(visit, mapping, role, labels) {
  const ids = mapping.dataElements?.[role] || [];
  for (const id of ids) if (visit.dataValues?.[id]) return optionName(labels, id, visit.dataValues[id]);
  return null;
}

// --------------------------------------------------------------------------
// Org units (names, payam, county) and the Anchor site linked to each
// --------------------------------------------------------------------------
async function orgUnitInfo(implementationId, uids, cache) {
  const missing = [...uids].filter((u) => !cache.has(u));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const r = await client.request("organisationUnits", {
      query: { filter: `id:in:[${chunk.join(",")}]`, fields: "id,displayName,parent[displayName,parent[displayName]]", paging: "false" },
    });
    for (const ou of r.organisationUnits || []) {
      cache.set(ou.id, { name: ou.displayName, parent: ou.parent?.displayName || null, county: ou.parent?.parent?.displayName || null });
    }
    for (const u of chunk) if (!cache.has(u)) cache.set(u, { name: u, parent: null, county: null });
  }
  const sites = await prisma.facility.findMany({
    where: { implementationId, dhis2OrgUnitId: { in: [...uids] } },
    select: { id: true, dhis2OrgUnitId: true },
  });
  return new Map(sites.map((s) => [s.dhis2OrgUnitId, s.id]));
}

// --------------------------------------------------------------------------
// Saving one tracked entity (child) with its enrolments and events
// --------------------------------------------------------------------------
async function saveTrackedEntity(config, te, ouCache, siteByOu, stats) {
  const { mapping, labels } = config;
  const attrs = new Map((te.attributes || []).map((a) => [a.attribute, optionName(labels, a.attribute, a.value)]));
  const a = mapping.attributes || {};
  const dob = dateOnly(attrs.get(a.dateOfBirth));
  const person = {
    patientId: attrs.get(a.patientId) || null,
    childName: attrs.get(a.childName) || null,
    caregiverName: attrs.get(a.caregiverName) || null,
    sex: attrs.get(a.sex) || null,
    dateOfBirth: dob,
    addressPayam: attrs.get(a.payam) || null,
    addressVillage: attrs.get(a.village) || null,
  };
  const ageAttr = num(attrs.get(a.ageMonths));

  for (const en of (te.enrollments || []).filter((x) => x.program === config.programId)) {
    const enrolledAt = dateOnly(en.enrolledAt);
    const existing = await prisma.dhis2Child.findUnique({ where: { enrollmentUid: en.enrollment }, select: { id: true } });
    if (!existing && config.startDate && enrolledAt && enrolledAt < config.startDate) {
      stats.beforeStart += 1;
      continue;
    }
    const visits = (en.events || []).map((e) => visitFromEvent(mapping, e, labels, config.commodity));
    const sum = summarise(mapping, en, visits, dob, ageAttr, labels);
    const ou = ouCache.get(en.orgUnit) || { name: en.orgUnit };
    const data = {
      programConfigId: config.id,
      implementationId: config.implementationId,
      trackedEntityUid: te.trackedEntity,
      orgUnitUid: en.orgUnit,
      orgUnitName: ou.name,
      orgUnitParentName: ou.parent || null,
      countyName: ou.county || null,
      facilityId: siteByOu.get(en.orgUnit) || null,
      ...person,
      ...sum,
      deleted: !!(te.deleted || en.deleted),
      dhis2UpdatedAt: wallTime(en.updatedAt),
    };
    await prisma.$transaction(async (tx) => {
      const child = await tx.dhis2Child.upsert({ where: { enrollmentUid: en.enrollment }, create: { enrollmentUid: en.enrollment, ...data }, update: data });
      for (const v of visits) {
        const saved = await tx.dhis2ChildVisit.upsert({ where: { eventUid: v.eventUid }, create: { ...v, childId: child.id }, update: { ...v, childId: child.id } });
        await tx.dhis2VisitCommodity.deleteMany({ where: { visitId: saved.id } });
        const counted = !v.deleted && !data.deleted && v.stage !== "DISCHARGE" && COUNTED.has(String(v.status || "").toUpperCase()) && v.occurredAt;
        if (counted && v.commodities?.length) {
          await tx.dhis2VisitCommodity.createMany({
            data: v.commodities.map((g) => ({ visitId: saved.id, childId: child.id, programConfigId: config.id, commodity: g.commodity, unit: g.unit, amount: g.amount, occurredAt: v.occurredAt })),
          });
        }
      }
    });
    stats[existing ? "updated" : "added"] += 1;
    stats.visits += visits.length;
  }
}

const TE_FIELDS =
  "trackedEntity,orgUnit,updatedAt,deleted,attributes[attribute,value]," +
  "enrollments[enrollment,program,orgUnit,status,enrolledAt,occurredAt,completedAt,updatedAt,deleted," +
  "events[event,programStage,status,occurredAt,scheduledAt,updatedAt,deleted,dataValues[dataElement,value]]]";

const listOf = (r, key) => r[key] || r.instances || [];

/** Uids of children whose details, enrolment or any visit changed since `since`. */
async function changedTrackedEntities(programId, since) {
  const uids = new Set();
  const deleted = new Set();
  const updatedAfter = since.toISOString().replace(/Z$/, "");
  const sources = [
    ["tracker/events", "events"],
    ["tracker/enrollments", "enrollments"],
    ["tracker/trackedEntities", "trackedEntities"],
  ];
  for (const [path, key] of sources) {
    for (let page = 1; page <= 1000; page += 1) {
      const r = await client.request(path, {
        query: { program: programId, ouMode: "ACCESSIBLE", updatedAfter, includeDeleted: "true", fields: "trackedEntity,deleted", pageSize: 500, page },
      });
      const rows = listOf(r, key);
      for (const x of rows) {
        if (!x.trackedEntity) continue;
        if (key === "trackedEntities" && x.deleted) deleted.add(x.trackedEntity);
        else uids.add(x.trackedEntity);
      }
      if (rows.length < 500) break;
    }
  }
  return { uids: [...uids].filter((u) => !deleted.has(u)), deleted: [...deleted] };
}

async function saveBatch(config, tes, ouCache, stats) {
  const ous = new Set();
  for (const te of tes) for (const en of te.enrollments || []) if (en.program === config.programId) ous.add(en.orgUnit);
  const siteByOu = await orgUnitInfo(config.implementationId, ous, ouCache);
  for (const te of tes) {
    stats.children += 1;
    await saveTrackedEntity(config, te, ouCache, siteByOu, stats);
  }
}

/** Sync one tracker program (full on the first run or with fromStart). */
async function syncTrackerProgram(configId, { trigger = "SCHEDULE", fromStart = false } = {}) {
  const key = `tracker:${configId}`;
  if (running.has(key)) return { skipped: "This program is already syncing" };
  running.add(key);
  let config = await prisma.dhis2TrackerProgram.findUnique({ where: { id: configId } });
  if (!config) {
    running.delete(key);
    throw new Error("Tracker program not found");
  }
  if (config.mapping?.version !== MAPPING_VERSION) {
    // New things to read (e.g. commodities per visit): refresh the mapping and read everything again.
    try {
      const detected = await detectMapping(config.programId);
      config = await prisma.dhis2TrackerProgram.update({ where: { id: config.id }, data: { mapping: detected.mapping, labels: detected.labels, pullCursor: null } });
    } catch (err) {
      running.delete(key);
      throw err;
    }
  }
  const run = await prisma.dhis2SyncRun.create({ data: { implementationId: config.implementationId, direction: `TRACKER:${config.code}`, trigger } });
  const stats = { mode: "", children: 0, added: 0, updated: 0, visits: 0, beforeStart: 0, removed: 0 };
  try {
    const startedAt = await serverWallNow();
    const ouCache = new Map();
    const full = fromStart || !config.pullCursor;
    stats.mode = full ? "full" : "changes";
    if (full) {
      for (let page = 1; page <= 10000; page += 1) {
        const r = await client.request("tracker/trackedEntities", {
          query: {
            program: config.programId,
            ouMode: "ACCESSIBLE",
            fields: TE_FIELDS,
            pageSize: 100,
            page,
            ...(config.startDate ? { enrollmentEnrolledAfter: config.startDate.toISOString().slice(0, 10) } : {}),
          },
        });
        const tes = listOf(r, "trackedEntities");
        await saveBatch(config, tes, ouCache, stats);
        if (tes.length < 100) break;
      }
    } else {
      const since = new Date(config.pullCursor.getTime() - OVERLAP_MS);
      const { uids, deleted } = await changedTrackedEntities(config.programId, since);
      for (let i = 0; i < uids.length; i += 50) {
        const r = await client.request("tracker/trackedEntities", {
          query: { program: config.programId, trackedEntities: uids.slice(i, i + 50).join(","), ouMode: "ACCESSIBLE", includeDeleted: "true", fields: TE_FIELDS, pageSize: 50 },
        });
        await saveBatch(config, listOf(r, "trackedEntities"), ouCache, stats);
      }
      if (deleted.length) {
        const r = await prisma.dhis2Child.updateMany({ where: { programConfigId: config.id, trackedEntityUid: { in: deleted } }, data: { deleted: true } });
        stats.removed = r.count;
      }
    }
    await prisma.dhis2TrackerProgram.update({ where: { id: config.id }, data: { pullCursor: startedAt, lastPullAt: new Date() } });
    await prisma.dhis2SyncRun.update({ where: { id: run.id }, data: { status: "SUCCESS", stats, finishedAt: new Date() } });
    return { ok: true, stats };
  } catch (err) {
    await prisma.dhis2SyncRun.update({ where: { id: run.id }, data: { status: "FAILED", stats, error: String(err.message || err).slice(0, 4000), finishedAt: new Date() } });
    return { ok: false, error: err.message || String(err), stats };
  } finally {
    running.delete(key);
  }
}

/** Scheduler hook: sync enabled programs whose interval has passed. */
async function syncDueTrackerPrograms() {
  const programs = await prisma.dhis2TrackerProgram.findMany({ where: { enabled: true } });
  if (!programs.length) return;
  const intervals = new Map(
    (await prisma.dhis2Config.findMany({ select: { implementationId: true, intervalMinutes: true } })).map((c) => [c.implementationId, c.intervalMinutes])
  );
  for (const p of programs) {
    const minutes = intervals.get(p.implementationId) || 60;
    if (p.lastPullAt && Date.now() - p.lastPullAt.getTime() < minutes * 60000) continue;
    await syncTrackerProgram(p.id);
  }
}

const isTrackerRunning = (configId) => running.has(`tracker:${configId}`);

module.exports = { detectMapping, optionName, commodityOf, givenAtVisit, totalsOf, syncTrackerProgram, syncDueTrackerPrograms, isTrackerRunning, summarise, visitFromEvent };
