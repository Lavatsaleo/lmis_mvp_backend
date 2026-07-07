const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

// ---------------- helpers ----------------
function computeAgeInMonths(dob, refDate = new Date()) {
  const d = new Date(dob);
  const now = new Date(refDate);
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  return Math.max(0, months);
}

function buildUniqueChildNumber({ facilityCode, cwcNumber, program }) {
  // Registration number format: SITE/CWC/PROGRAM (e.g., KTL001/12345/SQLNS)
  return `${facilityCode}/${cwcNumber}/${program}`.toUpperCase();
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeDateOnly(value) {
  const d = parseDateOrNull(value);
  if (!d) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfDay(value = new Date()) {
  const d = parseDateOrNull(value) || new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

async function findExistingVisitForSameChildAndDay(client, { childId, facilityId, visitDate }) {
  const dayStart = startOfDay(visitDate);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return client.childVisit.findFirst({
    where: {
      childId,
      facilityId,
      visitDate: {
        gte: dayStart,
        lt: dayEnd,
      },
    },
    orderBy: [{ visitDate: "asc" }, { id: "asc" }],
  });
}

function formatDateOnly(value) {
  const d = normalizeDateOnly(value);
  if (!d) return null;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function compareDescByDate(a, b) {
  const da = parseDateOrNull(a);
  const db = parseDateOrNull(b);

  const ta = da ? da.getTime() : 0;
  const tb = db ? db.getTime() : 0;

  return tb - ta;
}

function normalizeDuplicateText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeDuplicatePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskedPhone(value) {
  const digits = normalizeDuplicatePhone(value);
  if (!digits) return null;
  if (digits.length <= 3) return `***${digits}`;
  return `***${digits.slice(-3)}`;
}

function sameDateOnly(a, b) {
  const fa = formatDateOnly(a);
  const fb = formatDateOnly(b);
  return !!fa && !!fb && fa === fb;
}

function calculateDuplicateScore(input, child, activeFacilityId) {
  const reasons = [];
  let score = 0;

  const cwcIn = normalizeDuplicateText(input.cwcNumber);
  const cwcChild = normalizeDuplicateText(child.cwcNumber);
  if (cwcIn && cwcChild && cwcIn === cwcChild) {
    score += 55;
    reasons.push("Same CWC number");
  }

  const phoneIn = normalizeDuplicatePhone(input.caregiverContacts);
  const phoneChild = normalizeDuplicatePhone(child.caregiver?.contacts);
  if (phoneIn && phoneChild && phoneIn === phoneChild) {
    score += 25;
    reasons.push("Same caregiver phone");
  }

  if (input.dateOfBirth && sameDateOnly(input.dateOfBirth, child.dateOfBirth)) {
    score += 20;
    reasons.push("Same date of birth");
  }

  const sexIn = normalizeDuplicateText(input.sex);
  const sexChild = normalizeDuplicateText(child.sex);
  if (sexIn && sexChild && sexIn === sexChild) {
    score += 10;
    reasons.push("Same sex");
  }

  const firstIn = normalizeDuplicateText(input.firstName);
  const firstChild = normalizeDuplicateText(child.firstName);
  if (firstIn && firstChild) {
    if (firstIn === firstChild) {
      score += 10;
      reasons.push("Same first name");
    } else if (firstChild.includes(firstIn) || firstIn.includes(firstChild)) {
      score += 5;
      reasons.push("Similar first name");
    }
  }

  const lastIn = normalizeDuplicateText(input.lastName);
  const lastChild = normalizeDuplicateText(child.lastName);
  if (lastIn && lastChild) {
    if (lastIn === lastChild) {
      score += 10;
      reasons.push("Same last name");
    } else if (lastChild.includes(lastIn) || lastIn.includes(lastChild)) {
      score += 5;
      reasons.push("Similar last name");
    }
  }

  const caregiverIn = normalizeDuplicateText(input.caregiverName);
  const caregiverChild = normalizeDuplicateText(child.caregiver?.fullName);
  if (caregiverIn && caregiverChild) {
    if (caregiverIn === caregiverChild) {
      score += 12;
      reasons.push("Same caregiver name");
    } else if (caregiverChild.includes(caregiverIn) || caregiverIn.includes(caregiverChild)) {
      score += 6;
      reasons.push("Similar caregiver name");
    }
  }

  const villageIn = normalizeDuplicateText(input.village);
  const villageChild = normalizeDuplicateText(child.caregiver?.village);
  if (villageIn && villageChild && villageIn === villageChild) {
    score += 5;
    reasons.push("Same village/location");
  }

  const sameFacility = !!activeFacilityId && child.facilityId === activeFacilityId;
  return { score, reasons, sameFacility };
}


function duplicateInputFromEnrollmentBody(body = {}) {
  return {
    cwcNumber: String(body.cwcNumber || "").trim(),
    firstName: String(body.childFirstName ?? body.firstName ?? "").trim(),
    lastName: String(body.childLastName ?? body.lastName ?? "").trim(),
    dateOfBirth: String(body.dateOfBirth || "").trim(),
    sex: String(body.sex || "").trim(),
    caregiverName: String(body.caregiverName ?? body.fullName ?? "").trim(),
    caregiverContacts: String(body.caregiverContacts ?? body.contacts ?? "").trim(),
    village: String(body.village || "").trim(),
  };
}

function compactDuplicateCandidate(child, input, activeFacilityId) {
  const scored = calculateDuplicateScore(input, child, activeFacilityId);
  const lastVisit = Array.isArray(child.visits) && child.visits.length ? child.visits[0] : null;
  const lastSachetsDispensed = lastVisit ? sumVisitSachets(lastVisit) : 0;

  return {
    childId: child.id,
    uniqueChildNumber: child.uniqueChildNumber,
    cwcNumber: child.cwcNumber,
    childName: `${child.firstName || ""} ${child.lastName || ""}`.trim(),
    firstName: child.firstName,
    lastName: child.lastName,
    sex: child.sex,
    dateOfBirth: formatDateOnly(child.dateOfBirth),
    caregiverName: child.caregiver?.fullName || null,
    caregiverContactsMasked: maskedPhone(child.caregiver?.contacts),
    village: child.caregiver?.village || null,
    facilityId: child.facilityId,
    facilityCode: child.facility?.code || null,
    facilityName: child.facility?.name || null,
    sameFacility: scored.sameFacility,
    lastVisitDate: lastVisit ? formatDateOnly(lastVisit.visitDate) : null,
    lastSachetsDispensed,
    score: scored.score,
    reasons: scored.reasons,
  };
}

async function findDuplicateCandidates(client, input, activeFacilityId, options = {}) {
  const excludeChildId = options.excludeChildId ? String(options.excludeChildId) : null;
  const minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 25;

  const hasAnyUsefulInput = Object.values(input || {}).some((v) => String(v || "").trim() !== "");
  if (!hasAnyUsefulInput) return [];

  const or = [];

  if (input.cwcNumber) {
    or.push({ cwcNumber: input.cwcNumber });
    or.push({ uniqueChildNumber: { contains: input.cwcNumber } });
  }

  if (input.firstName) or.push({ firstName: { contains: input.firstName } });
  if (input.lastName) or.push({ lastName: { contains: input.lastName } });
  if (input.caregiverName) or.push({ caregiver: { fullName: { contains: input.caregiverName } } });
  if (input.caregiverContacts) or.push({ caregiver: { contacts: { contains: input.caregiverContacts } } });

  const dob = normalizeDateOnly(input.dateOfBirth);
  if (dob) {
    const dobEnd = new Date(dob);
    dobEnd.setDate(dobEnd.getDate() + 1);
    or.push({ dateOfBirth: { gte: dob, lt: dobEnd } });
  }

  if (or.length === 0) return [];

  const where = { OR: or };
  if (excludeChildId) where.id = { not: excludeChildId };

  const children = await client.child.findMany({
    where,
    include: {
      caregiver: true,
      facility: true,
      visits: {
        orderBy: { visitDate: "desc" },
        take: 1,
        include: { dispenses: true },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  return children
    .map((child) => compactDuplicateCandidate(child, input, activeFacilityId))
    .filter((m) => m.score >= minimumScore || (m.reasons || []).includes("Same CWC number"))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.childName || "").localeCompare(String(b.childName || ""));
    })
    .slice(0, 10);
}

function normalizeMobileDuplicateDecision(duplicateReview) {
  const status = String(duplicateReview?.status || "").trim().toUpperCase();
  const decision = String(duplicateReview?.userDecision || "").trim().toUpperCase();

  if (decision === "SAME_CHILD") return "SAME_CHILD";
  if (decision === "DIFFERENT_CHILD") return "DIFFERENT_CHILD";
  if (decision === "NOT_SURE") return "NOT_SURE";
  if (status === "PENDING_SERVER_CHECK") return "PENDING_SERVER_CHECK";
  if (status === "CHECKED_NO_MATCH") return "CHECKED_NO_MATCH";
  if (status === "POSSIBLE_DUPLICATE_REVIEWED_ON_MOBILE") return "NOT_SURE";
  return status || "UNKNOWN";
}

async function createDuplicateCasesForEnrollment(tx, {
  child,
  facility,
  performedByUserId,
  enrollmentBody,
}) {
  const duplicateReview = isPlainObject(enrollmentBody?.duplicateReview)
    ? enrollmentBody.duplicateReview
    : null;

  const input = duplicateInputFromEnrollmentBody(enrollmentBody || {});
  const mobileDecision = normalizeMobileDuplicateDecision(duplicateReview);

  let matches = await findDuplicateCandidates(tx, input, facility?.id, {
    excludeChildId: child.id,
    minimumScore: 25,
  });

  // If the mobile app had already shown a candidate but the server-side search
  // does not currently return it, keep the mobile audit trail by creating a case
  // from the saved topCandidate/candidateIds.
  if (matches.length === 0 && duplicateReview) {
    const topCandidate = isPlainObject(duplicateReview.topCandidate)
      ? duplicateReview.topCandidate
      : null;
    const candidateIds = Array.isArray(duplicateReview.candidateIds)
      ? duplicateReview.candidateIds.map((x) => String(x)).filter(Boolean)
      : [];

    if (topCandidate?.childId || candidateIds.length || mobileDecision === "PENDING_SERVER_CHECK") {
      matches = [
        {
          childId: topCandidate?.childId || candidateIds[0] || null,
          facilityId: null,
          score: Number.isFinite(Number(topCandidate?.score)) ? Math.round(Number(topCandidate.score)) : null,
          reasons: Array.isArray(topCandidate?.reasons) ? topCandidate.reasons : ["Mobile duplicate review saved"],
          ...topCandidate,
        },
      ];
    }
  }

  if (matches.length === 0 || mobileDecision === "CHECKED_NO_MATCH") {
    return [];
  }

  const created = [];
  for (const match of matches.slice(0, 5)) {
    const duplicateChildId = match.childId ? String(match.childId) : null;

    // Avoid creating repeated open cases for the same pair/source.
    const existing = duplicateChildId
      ? await tx.duplicateCase.findFirst({
          where: {
            primaryChildId: child.id,
            duplicateChildId,
            source: "MOBILE_ENROLLMENT",
            status: { in: ["OPEN", "UNDER_REVIEW"] },
          },
        })
      : null;

    if (existing) {
      created.push(existing);
      continue;
    }

    const c = await tx.duplicateCase.create({
      data: {
        primaryChildId: child.id,
        duplicateChildId,
        facilityId: child.facilityId || facility?.id || null,
        matchingFacilityId: match.facilityId || null,
        source: duplicateReview ? "MOBILE_ENROLLMENT" : "SERVER_SYNC_VALIDATION",
        status: "OPEN",
        mobileDecision,
        matchScore: Number.isFinite(Number(match.score)) ? Math.round(Number(match.score)) : null,
        matchReasons: Array.isArray(match.reasons) ? match.reasons : [],
        topCandidate: match,
        candidateIds: matches.map((m) => m.childId).filter(Boolean),
        payload: duplicateReview || { status: "SERVER_CHECK_CREATED_CASE" },
        createdByUserId: performedByUserId || null,
      },
    });
    created.push(c);
  }

  return created;
}

function normalizeAssessmentType(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (s === "ENROLLMENT" || s === "BASELINE") return "ENROLLMENT";
  if (s === "DISCHARGE" || s === "EXIT") return "DISCHARGE";
  return null;
}

function addLegacyChildFields(child) {
  if (!child) return child;
  return {
    ...child,
    // legacy aliases (keep old UI working)
    childFirstName: child.firstName,
    childLastName: child.lastName,
  };
}

function addLegacyCaregiverFields(caregiver) {
  if (!caregiver) return caregiver;
  return {
    ...caregiver,
    // legacy aliases (keep old UI working)
    caregiverName: caregiver.fullName,
    caregiverContacts: caregiver.contacts,
  };
}

function sumVisitSachets(visit) {
  if (!visit) return 0;
  if (Array.isArray(visit.dispenses)) {
    return visit.dispenses.reduce((sum, d) => sum + Math.round(Number(d?.quantitySachets || 0)), 0);
  }

  const direct = Number(visit.sachetsDispensed ?? visit.quantitySachets ?? visit.sachetsGiven);
  return Number.isFinite(direct) ? Math.round(direct) : 0;
}

function addLegacyVisitFields(visit) {
  if (!visit) return visit;

  const sachetsDispensed = sumVisitSachets(visit);

  return {
    ...visit,
    sachetsDispensed,
    quantitySachets: sachetsDispensed,
    sachetsGiven: sachetsDispensed,
    // legacy alias
    createdByUserId: visit.performedByUserId,
  };
}

function addLegacyDispenseFields(dispense, visit, child) {
  if (!dispense) return dispense;
  return {
    ...dispense,
    // legacy aliases
    sachetsGiven: dispense.quantitySachets,
    childVisitId: dispense.visitId,
    // useful derived context (old schema used to have these fields)
    childId: child?.id,
    facilityId: visit?.facilityId,
    dispensedByUserId: visit?.performedByUserId,
  };
}

function addLegacyAssessmentFields(assessment) {
  if (!assessment) return assessment;
  return {
    ...assessment,
    // legacy alias
    assessedAt: assessment.assessmentDate,
  };
}

function deriveLatestAppointmentVisit(visits) {
  if (!Array.isArray(visits) || visits.length === 0) return null;

  const withAppointment = visits.filter((v) => parseDateOrNull(v?.nextAppointmentDate));
  if (withAppointment.length === 0) return null;

  withAppointment.sort((a, b) => {
    const aAppt = parseDateOrNull(a?.nextAppointmentDate)?.getTime() || 0;
    const bAppt = parseDateOrNull(b?.nextAppointmentDate)?.getTime() || 0;
    if (bAppt !== aAppt) return bAppt - aAppt;

    const aVisit = parseDateOrNull(a?.visitDate)?.getTime() || 0;
    const bVisit = parseDateOrNull(b?.visitDate)?.getTime() || 0;
    return bVisit - aVisit;
  });

  return withAppointment[0];
}

// ---------------- stock helpers ----------------

/**
 * Auto-allocate sachets from facility stock WITHOUT requiring the client to scan a box.
 *
 * Allocation rule (simple + safe):
 *  - Use boxes in this facility with status IN_FACILITY
 *  - Consume from the earliest-expiring boxes first (FEFO)
 *  - Split across boxes if needed
 *
 * Returns the list of created dispense records (can be >1 if split across boxes).
 * Throws an Error with statusCode for validation failures.
 */
async function autoAllocateDispenseFromFacility(tx, {
  facilityId,
  performedByUserId,
  childUniqueNumber,
  visitId,
  quantitySachets,
  note,
}) {
  const qty = Math.round(Number(quantitySachets));
  if (!Number.isFinite(qty) || qty <= 0) {
    const e = new Error("quantitySachets must be a positive number");
    e.statusCode = 400;
    throw e;
  }

  const boxes = await tx.box.findMany({
    where: { currentFacilityId: facilityId, status: "IN_FACILITY" },
    select: {
      id: true,
      boxUid: true,
      expiryDate: true,
      sachetsPerBox: true,
      sachetsRemaining: true,
      createdAt: true,
    },
    orderBy: [
      { expiryDate: "asc" }, // FEFO
      { createdAt: "asc" },
    ],
  });

  if (!boxes || boxes.length === 0) {
    const e = new Error("No boxes available IN_FACILITY in this facility for dispensing");
    e.statusCode = 400;
    throw e;
  }

  const totalAvailable = boxes.reduce((acc, b) => {
    const perBox = Number.isFinite(b.sachetsPerBox) ? b.sachetsPerBox : 600;
    const rem = Number.isFinite(b.sachetsRemaining) ? b.sachetsRemaining : perBox;
    return acc + rem;
  }, 0);

  if (qty > totalAvailable) {
    const e = new Error("Not enough sachets remaining in facility stock");
    e.statusCode = 400;
    e.meta = { totalAvailable, requested: qty };
    throw e;
  }

  let remainingToAllocate = qty;
  const createdDispenses = [];

  for (const b of boxes) {
    if (remainingToAllocate <= 0) break;

    const perBox = Number.isFinite(b.sachetsPerBox) ? b.sachetsPerBox : 600;
    const rem = Number.isFinite(b.sachetsRemaining) ? b.sachetsRemaining : perBox;

    if (rem <= 0) continue;

    const take = Math.min(rem, remainingToAllocate);
    const newRemaining = rem - take;

    const d = await tx.dispense.create({
      data: {
        visitId,
        quantitySachets: take,
        boxId: b.id,
        note: note ?? null,
      },
    });

    createdDispenses.push({ dispense: d, boxUid: b.boxUid, taken: take, remainingAfter: newRemaining });

    await tx.box.update({
      where: { id: b.id },
      data: {
        sachetsRemaining: newRemaining,
        status: newRemaining === 0 ? "DISPENSED" : "IN_FACILITY",
      },
    });

    await tx.boxEvent.create({
      data: {
        boxId: b.id,
        type: "DISPENSE",
        performedByUserId,
        fromFacilityId: facilityId,
        note: `Dispensed ${take} sachets to child ${childUniqueNumber} (visit ${visitId}). Remaining in box: ${newRemaining}${note ? " • " + note : ""}`,
      },
    });

    remainingToAllocate -= take;
  }

  return createdDispenses;
}


async function reverseVisitDispensesToStock(tx, {
  visit,
  performedByUserId,
  reason,
}) {
  const dispenses = Array.isArray(visit?.dispenses) ? visit.dispenses : [];
  const reversed = [];

  for (const d of dispenses) {
    const qty = Math.round(Number(d?.quantitySachets || 0));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    if (d.boxId) {
      const box = await tx.box.findUnique({ where: { id: d.boxId } });
      if (box) {
        const perBox = Number.isFinite(box.sachetsPerBox) ? box.sachetsPerBox : 600;
        const currentRemaining = Number.isFinite(box.sachetsRemaining) ? box.sachetsRemaining : 0;
        const newRemaining = Math.min(perBox, currentRemaining + qty);

        await tx.box.update({
          where: { id: box.id },
          data: {
            sachetsRemaining: newRemaining,
            status: "IN_FACILITY",
          },
        });

        await tx.boxEvent.create({
          data: {
            boxId: box.id,
            type: "ADJUSTMENT",
            performedByUserId,
            toFacilityId: visit.facilityId,
            note: `Reversed ${qty} sachets from edited visit ${visit.id}. New remaining: ${newRemaining}${reason ? " • " + reason : ""}`,
          },
        });
      }
    }

    await tx.dispense.delete({ where: { id: d.id } });
    reversed.push({ id: d.id, quantitySachets: qty, boxId: d.boxId || null });
  }

  return reversed;
}

/**
 * Accepts either:
 *  - { assessmentDate/assessedAt, data: {...} }
 *  - { assessmentDate/assessedAt, ...anyOtherFields }
 *
 * Returns: { assessmentDate, data }
 */
function normalizeAssessmentPayload(payload) {
  const body = payload || {};
  const rawDate = body.assessmentDate ?? body.assessedAt;
  const assessmentDate = parseDateOrNull(rawDate) || new Date();

  if (Object.prototype.hasOwnProperty.call(body, "data")) {
    return { assessmentDate, data: body.data };
  }

  const { assessedAt: _a, assessmentDate: _b, ...rest } = body;
  return { assessmentDate, data: rest };
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function hungerCategoryFromScore(score) {
  if (!Number.isFinite(score)) return null;
  if (score <= 1) return "Little/no hunger";
  if (score <= 3) return "Moderate hunger";
  return "Severe hunger";
}

function computeHhsFromData(d) {
  const src = d || {};
  const h = src.hhs || src.householdHunger || src.householdHungerScoreDetail || src.answers?.hhs || src.answers?.householdHunger;

  // Support both nested and flat keys
  const get = (k) =>
    toNumberOrNull(h?.[k]) ??
    toNumberOrNull(src?.[k]) ??
    toNumberOrNull(src?.[`hhs_${k}`]) ??
    toNumberOrNull(src?.[`hhs${k.toUpperCase()}`]);

  const q1 = get("q1");
  const q1a = get("q1a");
  const q2 = get("q2");
  const q2a = get("q2a");
  const q3 = get("q3");
  const q3a = get("q3a");

  const scoreQuestion = (occ, freq) => {
    if (!Number.isFinite(occ)) return null;
    if (occ === 0) return 0;
    if (!Number.isFinite(freq)) return 1;
    if (freq === 3) return 2;
    return 1;
  };

  const s1 = scoreQuestion(q1, q1a);
  const s2 = scoreQuestion(q2, q2a);
  const s3 = scoreQuestion(q3, q3a);

  if ([s1, s2, s3].some((x) => x === null)) return null;

  const score = s1 + s2 + s3;
  return { score, category: hungerCategoryFromScore(score) };
}

function computePssFromData(d) {
  const src = d || {};
  const p = src.pss || src.pssScore || src.caregiverPss || src.answers?.pss;

  const get = (k) =>
    toNumberOrNull(p?.[k]) ??
    toNumberOrNull(src?.[k]) ??
    toNumberOrNull(src?.[`pss_${k}`]);

  const q1 = get("q1");
  const q2 = get("q2");
  const q3 = get("q3");
  const q4 = get("q4");
  const q5 = get("q5");

  if (![q1, q2, q3, q4, q5].every((x) => Number.isFinite(x))) return null;

  const score = q1 + q2 + q3 + q4 + q5;
  let category = null;
  if (score <= 2) category = "Low psycho-social risk";
  else if (score <= 5) category = "Moderate distress";
  else category = "High psycho-social stress / Severe distress";

  return { score, category };
}

function enrichAssessmentData(data) {
  const obj = isPlainObject(data) ? { ...data } : {};
  const derived = isPlainObject(obj.derived) ? { ...obj.derived } : {};

  if (derived.hhsScore == null && derived.householdHungerScore == null) {
    const hhs = computeHhsFromData(obj);
    if (hhs) {
      derived.hhsScore = hhs.score;
      derived.hhsCategory = hhs.category;
      derived.householdHungerScore = hhs.score;
      derived.householdHungerCategory = hhs.category;
    }
  }

  if (derived.pssScore == null) {
    const pss = computePssFromData(obj);
    if (pss) {
      derived.pssScore = pss.score;
      derived.pssCategory = pss.category;
    }
  }

  if (Object.keys(derived).length) obj.derived = derived;
  return obj;
}

function sameDay(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function extractAssessmentVisitMetrics(data) {
  const quick = extractAssessmentQuickFields(data);
  const d = data || {};

  const whzScore =
    toNumberOrNull(d.whzScore) ??
    toNumberOrNull(d.whz) ??
    toNumberOrNull(d?.anthropometrics?.whzScore) ??
    toNumberOrNull(d?.anthropometrics?.whz) ??
    toNumberOrNull(d?.answers?.whzScore) ??
    toNumberOrNull(d?.answers?.whz) ??
    toNumberOrNull(d?.answers?.anthropometrics?.whzScore) ??
    toNumberOrNull(d?.answers?.anthropometrics?.whz);

  return {
    weightKg: quick.weightKg,
    heightCm: quick.heightCm,
    muacMm: quick.muacMm,
    whzScore: Number.isFinite(whzScore) ? whzScore : null,
  };
}

function visitHasAnthroMetrics(visit) {
  if (!visit) return false;
  return [visit.weightKg, visit.heightCm, visit.muacMm, visit.whzScore].some(
    (v) => v !== null && v !== undefined && v !== ""
  );
}

function enrichVisitFromAssessmentIfNeeded(visit, assessment) {
  if (!visit || !assessment) return visit;
  if (visitHasAnthroMetrics(visit)) return visit;

  const looksLikeEnrollmentVisit =
    /enrollment/i.test(String(visit.notes || "")) ||
    sameDay(visit.visitDate, assessment.assessmentDate);

  if (!looksLikeEnrollmentVisit) return visit;

  const metrics = extractAssessmentVisitMetrics(assessment.data);

  return {
    ...visit,
    weightKg: visit.weightKg ?? metrics.weightKg,
    heightCm: visit.heightCm ?? metrics.heightCm,
    muacMm: visit.muacMm ?? metrics.muacMm,
    whzScore: visit.whzScore ?? metrics.whzScore,
    source: visit.source || "VISIT_WITH_ENROLLMENT_ASSESSMENT",
  };
}

function extractAssessmentQuickFields(data) {
  const d = data || {};

  const muacCandidate =
    toNumberOrNull(d.muacMm) ??
    toNumberOrNull(d.muac) ??
    toNumberOrNull(d.muacCm) ??
    toNumberOrNull(d?.anthropometrics?.muacMm) ??
    toNumberOrNull(d?.anthropometrics?.muac) ??
    toNumberOrNull(d?.anthropometrics?.muacCm) ??
    toNumberOrNull(d?.answers?.muacMm) ??
    toNumberOrNull(d?.answers?.muac) ??
    toNumberOrNull(d?.answers?.muacCm) ??
    toNumberOrNull(d?.answers?.anthropometrics?.muacMm) ??
    toNumberOrNull(d?.answers?.anthropometrics?.muac) ??
    toNumberOrNull(d?.answers?.anthropometrics?.muacCm);

  let muacMm = null;
  if (Number.isFinite(muacCandidate)) {
    if (muacCandidate > 0 && muacCandidate < 50) muacMm = Math.round(muacCandidate * 10);
    else muacMm = Math.round(muacCandidate);
  }

  const weightKg =
    toNumberOrNull(d.weightKg) ??
    toNumberOrNull(d.weight) ??
    toNumberOrNull(d?.anthropometrics?.weightKg) ??
    toNumberOrNull(d?.anthropometrics?.weight) ??
    toNumberOrNull(d?.answers?.weightKg) ??
    toNumberOrNull(d?.answers?.weight) ??
    toNumberOrNull(d?.answers?.anthropometrics?.weightKg);

  const heightCm =
    toNumberOrNull(d.heightCm) ??
    toNumberOrNull(d.height) ??
    toNumberOrNull(d.lengthCm) ??
    toNumberOrNull(d?.anthropometrics?.heightCm) ??
    toNumberOrNull(d?.anthropometrics?.height) ??
    toNumberOrNull(d?.anthropometrics?.lengthCm) ??
    toNumberOrNull(d?.answers?.heightCm) ??
    toNumberOrNull(d?.answers?.height) ??
    toNumberOrNull(d?.answers?.anthropometrics?.heightCm);

  const householdHungerScore =
    toNumberOrNull(d.householdHungerScore) ??
    toNumberOrNull(d.hhsScore) ??
    toNumberOrNull(d?.derived?.householdHungerScore) ??
    toNumberOrNull(d?.derived?.hhsScore) ??
    toNumberOrNull(d?.answers?.householdHungerScore);

  const householdHungerCategory =
    (typeof d.householdHungerCategory === "string" ? d.householdHungerCategory : null) ??
    (typeof d.hhsCategory === "string" ? d.hhsCategory : null) ??
    (typeof d?.derived?.householdHungerCategory === "string" ? d.derived.householdHungerCategory : null) ??
    (typeof d?.derived?.hhsCategory === "string" ? d.derived.hhsCategory : null) ??
    hungerCategoryFromScore(householdHungerScore);

  return {
    muacMm,
    weightKg: Number.isFinite(weightKg) ? weightKg : null,
    heightCm: Number.isFinite(heightCm) ? heightCm : null,
    householdHungerScore: Number.isFinite(householdHungerScore) ? householdHungerScore : null,
    householdHungerCategory,
  };
}

async function resolveFacilityForClinical(req, body) {
  if (req.user.role === "SUPER_ADMIN" && body.facilityCode) {
    return prisma.facility.findUnique({ where: { code: String(body.facilityCode).trim() } });
  }

  if (!req.user.facilityId) return null;
  return prisma.facility.findUnique({ where: { id: req.user.facilityId } });
}

async function assertChildInMyFacility(req, childId) {
  const child = await prisma.child.findUnique({ where: { id: childId } });
  if (!child) return null;

  if (req.user.role === "SUPER_ADMIN") return child;

  if (!req.user.facilityId) return null;
  if (child.facilityId !== req.user.facilityId) return "FORBIDDEN";
  return child;
}

async function buildChildSummaryPayload(childId) {
  const child = await prisma.child.findUnique({
    where: { id: childId },
    include: {
      caregiver: true,
      facility: true,
      inDepthAssessments: { orderBy: { assessmentDate: "desc" } },
      visits: {
        orderBy: { visitDate: "desc" },
        include: {
          dispenses: {
            orderBy: { createdAt: "desc" },
            include: { box: true },
          },
        },
      },
    },
  });

  if (!child) return null;

  const enrollmentAssessment =
    (child.inDepthAssessments || []).find((a) => a.assessmentType === "ENROLLMENT") || null;

  const visits = (child.visits || []).map((v) => {
    const dispenses = (v.dispenses || []).map((d) => addLegacyDispenseFields(d, v, child));
    const enrichedVisit = enrichVisitFromAssessmentIfNeeded({ ...v, dispenses }, enrollmentAssessment);
    return addLegacyVisitFields(enrichedVisit);
  });

  if (enrollmentAssessment) {
    const alreadyRepresented = visits.some((v) => sameDay(v.visitDate, enrollmentAssessment.assessmentDate));

    if (!alreadyRepresented) {
      visits.push(
        addLegacyVisitFields({
          id: `assessment-${enrollmentAssessment.id}`,
          childId: child.id,
          facilityId: child.facilityId,
          performedByUserId: enrollmentAssessment.performedByUserId,
          visitDate: enrollmentAssessment.assessmentDate,
          notes: "Enrollment assessment",
          nextAppointmentDate: null,
          dispenses: [],
          source: "ENROLLMENT_ASSESSMENT",
          ...extractAssessmentVisitMetrics(enrollmentAssessment.data),
          createdAt: enrollmentAssessment.createdAt,
        })
      );
    }

    visits.sort((a, b) => new Date(b.visitDate).getTime() - new Date(a.visitDate).getTime());
  }

  const assessments = (child.inDepthAssessments || []).map((a) => addLegacyAssessmentFields(a));

  const outChild = addLegacyChildFields({
    ...child,
    caregiver: addLegacyCaregiverFields(child.caregiver),
    inDepthAssessment: enrollmentAssessment ? addLegacyAssessmentFields(enrollmentAssessment) : null,
    inDepthAssessments: assessments,
    visits,
  });

  return {
    ...outChild,
    ageInMonths: computeAgeInMonths(child.dateOfBirth),
  };
}

// ---------------- routes ----------------

router.post(
  "/enroll",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const body = req.body || {};

      const caregiverName = String(body.caregiverName ?? body.fullName ?? "").trim();
      const caregiverContacts = String(body.caregiverContacts ?? body.contacts ?? "").trim();
      const village = body.village ? String(body.village).trim() : null;

      const childFirstName = String(body.childFirstName ?? body.firstName ?? "").trim();
      const childLastName = String(body.childLastName ?? body.lastName ?? "").trim();
      const dateOfBirthRaw = body.dateOfBirth;
      const cwcNumber = String(body.cwcNumber ?? "").trim();

      const required = [
        ["caregiverName", caregiverName],
        ["caregiverContacts", caregiverContacts],
        ["childFirstName", childFirstName],
        ["childLastName", childLastName],
        ["dateOfBirth", dateOfBirthRaw],
        ["cwcNumber", cwcNumber],
      ];
      for (const [k, v] of required) {
        if (!v) return res.status(400).json({ message: `${k} is required` });
      }

      const facility = await resolveFacilityForClinical(req, body);
      if (!facility) return res.status(400).json({ message: "Facility not found" });
      if (facility.type !== "FACILITY") {
        return res
          .status(400)
          .json({ message: "Clinical enrollment must be done in a FACILITY (not a warehouse)." });
      }

      const dob = parseDateOrNull(dateOfBirthRaw);
      if (!dob) {
        return res.status(400).json({ message: "dateOfBirth must be a valid date (YYYY-MM-DD)" });
      }

      let enrollmentDate = new Date();
      if (
        body.enrollmentDate !== undefined &&
        body.enrollmentDate !== null &&
        String(body.enrollmentDate).trim() !== ""
      ) {
        const parsed = parseDateOrNull(body.enrollmentDate);
        if (!parsed) {
          return res.status(400).json({ message: "enrollmentDate must be a valid date (YYYY-MM-DD)" });
        }
        enrollmentDate = parsed;
      }

      const today = startOfDay(new Date());
      const enrollmentDay = startOfDay(enrollmentDate);
      const dobDay = startOfDay(dob);

      if (enrollmentDay > today) {
        return res.status(400).json({ message: "enrollmentDate cannot be in the future" });
      }

      if (enrollmentDay < dobDay) {
        return res.status(400).json({ message: "enrollmentDate cannot be before dateOfBirth" });
      }

      const ageMonthsAtEnrollment = computeAgeInMonths(dob, enrollmentDate);
      if (ageMonthsAtEnrollment < 6 || ageMonthsAtEnrollment > 23) {
        return res.status(400).json({
          message: "Child is not eligible for this program. Only children aged 6–23 months can be enrolled.",
          ageInMonths: ageMonthsAtEnrollment,
        });
      }

      const program = body.program ? String(body.program).toUpperCase() : "SQLNS";
      if (program !== "SQLNS") {
        return res.status(400).json({ message: "Only program SQLNS is supported for now" });
      }

      const uniqueChildNumber = buildUniqueChildNumber({
        facilityCode: facility.code,
        cwcNumber,
        program,
      });

      const existingChild = await prisma.child.findFirst({
        where: {
          OR: [{ uniqueChildNumber }, { facilityId: facility.id, cwcNumber }],
        },
        include: { caregiver: true },
      });
      if (existingChild) {
        return res.status(409).json({
          message: "Child already exists (uniqueChildNumber duplicate)",
          child: existingChild,
        });
      }

      let baselineAssessmentInput = null;
      if (body.inDepthAssessment != null) {
        if (!isPlainObject(body.inDepthAssessment)) {
          return res.status(400).json({ message: "inDepthAssessment must be an object" });
        }

        const rawDate = body.inDepthAssessment.assessmentDate ?? body.inDepthAssessment.assessedAt;
        if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== "") {
          const parsed = parseDateOrNull(rawDate);
          if (!parsed) {
            return res.status(400).json({
              message: "inDepthAssessment.assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)",
            });
          }
        }

        const normalized = normalizeAssessmentPayload(body.inDepthAssessment);
        if (!isPlainObject(normalized.data)) {
          return res
            .status(400)
            .json({ message: "inDepthAssessment data must be an object (send { data: {...} })" });
        }

        baselineAssessmentInput = {
          assessmentDate: normalized.assessmentDate,
          data: enrichAssessmentData(normalized.data),
        };
      }

      let enrollmentVisitInput = null;
      if (isPlainObject(body.visit)) {
        const v = body.visit;
        const sachets = Number(v.sachetsDispensed ?? v.quantitySachets ?? v.sachetsGiven);
        if (!Number.isFinite(sachets) || sachets <= 0) {
          return res.status(400).json({ message: "visit.sachetsDispensed must be a positive number" });
        }

        let visitDate = null;
        if (
          v.visitDate !== undefined &&
          v.visitDate !== null &&
          String(v.visitDate).trim() !== ""
        ) {
          const parsedVisit = parseDateOrNull(v.visitDate);
          if (!parsedVisit) {
            return res.status(400).json({ message: "visit.visitDate must be a valid date (YYYY-MM-DD)" });
          }
          visitDate = parsedVisit;
        }

        let nextAppointmentDate = null;
        if (
          v.nextAppointmentDate !== undefined &&
          v.nextAppointmentDate !== null &&
          String(v.nextAppointmentDate).trim() !== ""
        ) {
          const parsedNext = parseDateOrNull(v.nextAppointmentDate);
          if (!parsedNext) {
            return res.status(400).json({ message: "visit.nextAppointmentDate must be a valid date (YYYY-MM-DD)" });
          }
          nextAppointmentDate = parsedNext;
        }

        const weightKg = toNumberOrNull(v.weightKg ?? v.weight);
        const heightCm = toNumberOrNull(v.heightCm ?? v.height ?? v.lengthCm);
        const muacRaw = toNumberOrNull(v.muacMm ?? v.muac ?? v.muacCm);
        let muacMm = null;
        if (Number.isFinite(muacRaw)) {
          muacMm = muacRaw > 0 && muacRaw < 50 ? Math.round(muacRaw * 10) : Math.round(muacRaw);
        }
        const whzScore = toNumberOrNull(v.whzScore ?? v.whz);

        enrollmentVisitInput = {
          sachetsDispensed: Math.round(sachets),
          visitDate,
          nextAppointmentDate,
          notes: v.notes ? String(v.notes) : null,
          weightKg: Number.isFinite(weightKg) ? weightKg : null,
          heightCm: Number.isFinite(heightCm) ? heightCm : null,
          muacMm,
          whzScore: Number.isFinite(whzScore) ? whzScore : null,
        };
      }

      const created = await prisma.$transaction(async (tx) => {
        let caregiver = await tx.caregiver.findFirst({
          where: {
            facilityId: facility.id,
            contacts: caregiverContacts,
          },
        });

        if (!caregiver) {
          try {
            caregiver = await tx.caregiver.create({
              data: {
                facilityId: facility.id,
                fullName: caregiverName,
                contacts: caregiverContacts,
                village,
              },
            });
          } catch (err) {
            if (err?.code === "P2002") {
              caregiver = await tx.caregiver.findFirst({
                where: {
                  facilityId: facility.id,
                  contacts: caregiverContacts,
                },
              });
              if (!caregiver) throw err;
            } else {
              throw err;
            }
          }
        }

        const sex = body.sex ? String(body.sex).toUpperCase() : "UNKNOWN";

        const child = await tx.child.create({
          data: {
            facilityId: facility.id,
            caregiverId: caregiver.id,
            firstName: childFirstName,
            lastName: childLastName,
            sex,
            dateOfBirth: dob,
            cwcNumber,
            uniqueChildNumber,
            program,
            enrollmentDate,
            chpName: body.chpName ? String(body.chpName).trim() : null,
            chpContacts: body.chpContacts ? String(body.chpContacts).trim() : null,
          },
        });

        let assessment = null;
        if (baselineAssessmentInput) {
          const quick = extractAssessmentQuickFields(baselineAssessmentInput.data);

          assessment = await tx.inDepthAssessment.create({
            data: {
              childId: child.id,
              facilityId: facility.id,
              performedByUserId: req.user.id,
              assessmentType: "ENROLLMENT",
              assessmentDate: baselineAssessmentInput.assessmentDate,
              data: baselineAssessmentInput.data,
              ...quick,
            },
          });
        }

        let enrollmentVisit = null;
        let enrollmentDispenses = [];
        if (enrollmentVisitInput) {
          const baselineVisitMetrics = baselineAssessmentInput
            ? extractAssessmentVisitMetrics(baselineAssessmentInput.data)
            : {};

          enrollmentVisit = await tx.childVisit.create({
            data: {
              childId: child.id,
              facilityId: facility.id,
              performedByUserId: req.user.id,
              visitDate: enrollmentVisitInput.visitDate ?? baselineAssessmentInput?.assessmentDate ?? enrollmentDate,
              nextAppointmentDate: enrollmentVisitInput.nextAppointmentDate,
              notes: enrollmentVisitInput.notes ?? "Enrollment dispense",
              weightKg: enrollmentVisitInput.weightKg ?? baselineVisitMetrics.weightKg ?? null,
              heightCm: enrollmentVisitInput.heightCm ?? baselineVisitMetrics.heightCm ?? null,
              muacMm: enrollmentVisitInput.muacMm ?? baselineVisitMetrics.muacMm ?? null,
              whzScore: enrollmentVisitInput.whzScore ?? baselineVisitMetrics.whzScore ?? null,
            },
          });

          const auto = await autoAllocateDispenseFromFacility(tx, {
            facilityId: facility.id,
            performedByUserId: req.user.id,
            childUniqueNumber: uniqueChildNumber,
            visitId: enrollmentVisit.id,
            quantitySachets: enrollmentVisitInput.sachetsDispensed,
            note: "Enrollment dispense",
          });

          enrollmentDispenses = auto.map((a) => a.dispense);
        }

        const duplicateCases = await createDuplicateCasesForEnrollment(tx, {
          child,
          facility,
          performedByUserId: req.user.id,
          enrollmentBody: body,
        });

        return { caregiver, child, assessment, enrollmentVisit, enrollmentDispenses, duplicateCases };
      });

      return res.status(201).json({
        message: "Enrollment successful",
        facility: { id: facility.id, code: facility.code, name: facility.name },
        caregiver: addLegacyCaregiverFields(created.caregiver),
        child: addLegacyChildFields(created.child),
        assessment: addLegacyAssessmentFields(created.assessment),
        visit: created.enrollmentVisit ? addLegacyVisitFields(created.enrollmentVisit) : null,
        dispense: (created.enrollmentDispenses || []).map((d) =>
          addLegacyDispenseFields(d, created.enrollmentVisit, created.child)
        ),
        duplicateReview: {
          caseCount: Array.isArray(created.duplicateCases) ? created.duplicateCases.length : 0,
          cases: (created.duplicateCases || []).map((c) => ({
            id: c.id,
            status: c.status,
            mobileDecision: c.mobileDecision,
            duplicateChildId: c.duplicateChildId,
            matchScore: c.matchScore,
          })),
        },
      });
    } catch (err) {
      console.error(err);
      const status = err.statusCode || 500;
      const payload = { message: status === 500 ? "Server error" : String(err.message || err) };
      if (err.meta) payload.meta = err.meta;
      if (status === 500) payload.error = String(err.message || err);
      return res.status(status).json(payload);
    }
  }
);


router.get(
  "/children/duplicate-check",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const input = {
        cwcNumber: String(req.query.cwcNumber || "").trim(),
        firstName: String(req.query.firstName || "").trim(),
        lastName: String(req.query.lastName || "").trim(),
        dateOfBirth: String(req.query.dateOfBirth || "").trim(),
        sex: String(req.query.sex || "").trim(),
        caregiverName: String(req.query.caregiverName || "").trim(),
        caregiverContacts: String(req.query.caregiverContacts || "").trim(),
        village: String(req.query.village || "").trim(),
      };

      const activeFacility = await resolveFacilityForClinical(req, req.query || {});
      const matches = await findDuplicateCandidates(prisma, input, activeFacility?.id, {
        minimumScore: 25,
      });

      return res.json({
        matches,
        currentFacility: activeFacility
          ? { id: activeFacility.id, code: activeFacility.code, name: activeFacility.name }
          : null,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.get(
  "/children/search",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q) return res.json([]);

      const facility = await resolveFacilityForClinical(req, {});
      if (!facility && req.user.role !== "SUPER_ADMIN") {
        return res.status(400).json({ message: "Your user has no facility assigned" });
      }

      const where = {
        OR: [
          { uniqueChildNumber: { contains: q } },
          { cwcNumber: { contains: q } },
          { firstName: { contains: q } },
          { lastName: { contains: q } },
          { caregiver: { fullName: { contains: q } } },
          { caregiver: { contacts: { contains: q } } },
        ],
      };

      if (req.user.role !== "SUPER_ADMIN") {
        where.facilityId = facility.id;
      }

      const children = await prisma.child.findMany({
        where,
        include: { caregiver: true, facility: true },
        take: 50,
        orderBy: { createdAt: "desc" },
      });

      const out = children.map((c) => ({
        ...addLegacyChildFields({
          ...c,
          caregiver: addLegacyCaregiverFields(c.caregiver),
          facility: c.facility ? { id: c.facility.id, code: c.facility.code, name: c.facility.name } : null,
          facilityCode: c.facility?.code,
        }),
        ageInMonths: computeAgeInMonths(c.dateOfBirth),
      }));

      return res.json(out);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.patch(
  "/children/:childId",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const existing = await prisma.child.findUnique({
        where: { id: req.params.childId },
        include: { caregiver: true, facility: true },
      });
      if (!existing) return res.status(404).json({ message: "Child not found" });

      const body = req.body || {};

      const caregiverNameRaw = body.caregiverName ?? body.fullName;
      const caregiverContactsRaw = body.caregiverContacts ?? body.contacts;
      const villageRaw = body.village;

      const firstNameRaw = body.childFirstName ?? body.firstName;
      const lastNameRaw = body.childLastName ?? body.lastName;
      const sexRaw = body.sex;
      const dateOfBirthRaw = body.dateOfBirth;
      const enrollmentDateRaw = body.enrollmentDate;
      const cwcNumberRaw = body.cwcNumber;
      const chpNameRaw = body.chpName;
      const chpContactsRaw = body.chpContacts;

      const childData = {};
      const caregiverData = {};

      if (firstNameRaw !== undefined) {
        const v = String(firstNameRaw || "").trim();
        if (!v) return res.status(400).json({ message: "firstName cannot be empty" });
        childData.firstName = v;
      }

      if (lastNameRaw !== undefined) {
        const v = String(lastNameRaw || "").trim();
        if (!v) return res.status(400).json({ message: "lastName cannot be empty" });
        childData.lastName = v;
      }

      if (sexRaw !== undefined) {
        const s = String(sexRaw || "").trim().toUpperCase();
        if (!["MALE", "FEMALE", "UNKNOWN"].includes(s)) {
          return res.status(400).json({ message: "sex must be MALE, FEMALE, or UNKNOWN" });
        }
        childData.sex = s;
      }

      if (dateOfBirthRaw !== undefined) {
        const dob = parseDateOrNull(dateOfBirthRaw);
        if (!dob) return res.status(400).json({ message: "dateOfBirth must be a valid date (YYYY-MM-DD)" });
        childData.dateOfBirth = dob;
      }

      if (enrollmentDateRaw !== undefined) {
        const enrollmentDate = parseDateOrNull(enrollmentDateRaw);
        if (!enrollmentDate) return res.status(400).json({ message: "enrollmentDate must be a valid date (YYYY-MM-DD)" });
        childData.enrollmentDate = enrollmentDate;
      }

      let nextCwcNumber = existing.cwcNumber;
      if (cwcNumberRaw !== undefined) {
        const c = String(cwcNumberRaw || "").trim();
        if (!c) return res.status(400).json({ message: "cwcNumber cannot be empty" });
        nextCwcNumber = c;
        childData.cwcNumber = c;
      }

      if (chpNameRaw !== undefined) {
        const v = String(chpNameRaw || "").trim();
        childData.chpName = v || null;
      }

      if (chpContactsRaw !== undefined) {
        const v = String(chpContactsRaw || "").trim();
        childData.chpContacts = v || null;
      }

      if (caregiverNameRaw !== undefined) {
        const v = String(caregiverNameRaw || "").trim();
        if (!v) return res.status(400).json({ message: "caregiverName cannot be empty" });
        caregiverData.fullName = v;
      }

      if (caregiverContactsRaw !== undefined) {
        const v = String(caregiverContactsRaw || "").trim();
        if (!v) return res.status(400).json({ message: "caregiverContacts cannot be empty" });
        caregiverData.contacts = v;
      }

      if (villageRaw !== undefined) {
        const v = String(villageRaw || "").trim();
        caregiverData.village = v || null;
      }

      if (!Object.keys(childData).length && !Object.keys(caregiverData).length) {
        return res.status(400).json({ message: "No editable child fields were provided" });
      }

      const facilityCode = existing.facility?.code;
      if (!facilityCode) {
        return res.status(400).json({ message: "Facility code is missing for this child" });
      }

      const nextUniqueChildNumber = buildUniqueChildNumber({
        facilityCode,
        cwcNumber: nextCwcNumber,
        program: existing.program,
      });

      if (nextCwcNumber !== existing.cwcNumber || nextUniqueChildNumber !== existing.uniqueChildNumber) {
        const duplicateChild = await prisma.child.findFirst({
          where: {
            id: { not: existing.id },
            OR: [
              { facilityId: existing.facilityId, cwcNumber: nextCwcNumber },
              { uniqueChildNumber: nextUniqueChildNumber },
            ],
          },
          select: { id: true, uniqueChildNumber: true, cwcNumber: true },
        });

        if (duplicateChild) {
          return res.status(409).json({
            message: "Another child already uses this CWC number / registration number in this facility",
            child: duplicateChild,
          });
        }
      }

      const nextCaregiverContacts = caregiverData.contacts ?? existing.caregiver.contacts;
      if (nextCaregiverContacts !== existing.caregiver.contacts) {
        const duplicateCaregiver = await prisma.caregiver.findFirst({
          where: {
            id: { not: existing.caregiverId },
            facilityId: existing.facilityId,
            contacts: nextCaregiverContacts,
          },
          select: { id: true, fullName: true, contacts: true },
        });

        if (duplicateCaregiver) {
          return res.status(409).json({
            message: "Another caregiver in this facility already uses those contacts. Update blocked to avoid an accidental merge.",
            caregiver: duplicateCaregiver,
          });
        }
      }

      const effectiveDob = childData.dateOfBirth || existing.dateOfBirth;
      const effectiveEnrollmentDate = childData.enrollmentDate || existing.enrollmentDate;

      if (Object.prototype.hasOwnProperty.call(childData, "enrollmentDate")) {
        const today = new Date();
        const todayDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
        const enrollmentDay = new Date(Date.UTC(
          effectiveEnrollmentDate.getUTCFullYear(),
          effectiveEnrollmentDate.getUTCMonth(),
          effectiveEnrollmentDate.getUTCDate()
        ));
        if (enrollmentDay > todayDay) {
          return res.status(400).json({ message: "enrollmentDate cannot be in the future" });
        }
      }

      if (effectiveEnrollmentDate < effectiveDob) {
        return res.status(400).json({ message: "enrollmentDate cannot be before dateOfBirth" });
      }

      if (
        Object.prototype.hasOwnProperty.call(childData, "dateOfBirth") ||
        Object.prototype.hasOwnProperty.call(childData, "enrollmentDate")
      ) {
        const ageMonths = computeAgeInMonths(effectiveDob, effectiveEnrollmentDate);
        if (ageMonths < 6 || ageMonths > 23) {
          return res.status(400).json({
            message: "Child is not eligible for this program. Only children aged 6–23 months can be enrolled.",
            ageInMonths: ageMonths,
          });
        }
      }

      if (nextUniqueChildNumber !== existing.uniqueChildNumber) {
        childData.uniqueChildNumber = nextUniqueChildNumber;
      }

      await prisma.$transaction(async (tx) => {
        if (Object.keys(caregiverData).length) {
          await tx.caregiver.update({
            where: { id: existing.caregiverId },
            data: caregiverData,
          });
        }

        if (Object.keys(childData).length) {
          await tx.child.update({
            where: { id: existing.id },
            data: childData,
          });
        }
      });

      const summary = await buildChildSummaryPayload(existing.id);
      return res.json({ message: "Child updated", child: summary });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.get(
  "/children/:childId/summary",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const summary = await buildChildSummaryPayload(req.params.childId);
      if (!summary) return res.status(404).json({ message: "Child not found" });

      return res.json(summary);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.post(
  "/children/:childId/visits",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const body = req.body || {};
      let visitDate = new Date();
      if (body.visitDate !== undefined && body.visitDate !== null && String(body.visitDate).trim() !== "") {
        const parsed = parseDateOrNull(body.visitDate);
        if (!parsed) {
          return res.status(400).json({ message: "visitDate must be a valid date (YYYY-MM-DD)" });
        }
        visitDate = parsed;
      }

      if (startOfDay(visitDate) < startOfDay(childCheck.enrollmentDate)) {
        return res.status(400).json({ message: "visitDate cannot be before the child's enrollmentDate" });
      }

      const weightKg = toNumberOrNull(body.weightKg ?? body.weight);
      const heightCm = toNumberOrNull(body.heightCm ?? body.height);

      const muacMmCandidate = toNumberOrNull(body.muacMm ?? body.muac);
      const muacMm = Number.isFinite(muacMmCandidate) ? Math.round(muacMmCandidate) : null;

      const whzScore = toNumberOrNull(body.whzScore ?? body.whz);

      let nextAppointmentDate = null;
      if (
        body.nextAppointmentDate !== undefined &&
        body.nextAppointmentDate !== null &&
        String(body.nextAppointmentDate).trim() !== ""
      ) {
        const parsedNext = parseDateOrNull(body.nextAppointmentDate);
        if (!parsedNext) {
          return res.status(400).json({ message: "nextAppointmentDate must be a valid date (YYYY-MM-DD)" });
        }
        nextAppointmentDate = parsedNext;
      }

      const existingSameDayVisit = await findExistingVisitForSameChildAndDay(prisma, {
        childId: childCheck.id,
        facilityId: childCheck.facilityId,
        visitDate,
      });

      if (existingSameDayVisit) {
        const existingVisitWithDispenses = await prisma.childVisit.findUnique({
          where: { id: existingSameDayVisit.id },
          include: { dispenses: true },
        });

        const outVisit = addLegacyVisitFields(existingVisitWithDispenses);
        const outDispenses = (existingVisitWithDispenses?.dispenses || []).map((d) =>
          addLegacyDispenseFields(d, existingVisitWithDispenses, childCheck)
        );

        return res.status(409).json({
          message: `A visit for this child already exists on ${formatDateOnly(visitDate)}. Open the existing visit instead of creating another one.`,
          existingVisit: {
            ...outVisit,
            dispenses: outDispenses,
          },
        });
      }

      const dispenseItems = Array.isArray(body.dispenses)
        ? body.dispenses
        : body.quantitySachets != null || body.sachetsGiven != null
          ? [
              {
                quantitySachets: body.quantitySachets ?? body.sachetsGiven,
                boxUid: body.boxUid,
                note: body.dispenseNote ?? body.note,
              },
            ]
          : [];

      const result = await prisma.$transaction(async (tx) => {
        const createdVisit = await tx.childVisit.create({
          data: {
            childId: childCheck.id,
            facilityId: childCheck.facilityId,
            performedByUserId: req.user.id,
            visitDate,
            notes: body.notes ? String(body.notes) : null,
            weightKg,
            heightCm,
            muacMm,
            whzScore,
            nextAppointmentDate,
          },
        });

        // Bump child.updatedAt so facility delta sync pulls this child/visit to other phones.
        await tx.child.update({
          where: { id: childCheck.id },
          data: { updatedAt: new Date() },
        });

        const createdDispenses = [];

        for (const item of dispenseItems) {
          const qty = Number(item?.quantitySachets ?? item?.sachetsGiven);
          if (!Number.isFinite(qty) || qty <= 0) {
            const e = new Error("quantitySachets must be a positive number");
            e.statusCode = 400;
            throw e;
          }

          const boxUid = item?.boxUid ? String(item.boxUid).trim() : null;
          const note = item?.note ? String(item.note) : null;

          if (!boxUid) {
            const auto = await autoAllocateDispenseFromFacility(tx, {
              facilityId: childCheck.facilityId,
              performedByUserId: req.user.id,
              childUniqueNumber: childCheck.uniqueChildNumber,
              visitId: createdVisit.id,
              quantitySachets: Math.round(qty),
              note,
            });

            for (const a of auto) {
              createdDispenses.push(a.dispense);
            }
            continue;
          }

          const box = await tx.box.findUnique({ where: { boxUid } });
          if (!box) {
            const e = new Error("Box not found");
            e.statusCode = 404;
            throw e;
          }

          if (box.currentFacilityId !== childCheck.facilityId || box.status !== "IN_FACILITY") {
            const e = new Error("Box is not available IN_FACILITY in this facility for dispensing");
            e.statusCode = 400;
            e.meta = { currentStatus: box.status, currentFacilityId: box.currentFacilityId };
            throw e;
          }

          const perBox = Number.isFinite(box.sachetsPerBox) ? box.sachetsPerBox : 600;
          const remaining = Number.isFinite(box.sachetsRemaining) ? box.sachetsRemaining : perBox;
          const newRemaining = remaining - Math.round(qty);
          if (newRemaining < 0) {
            const e = new Error("Not enough sachets remaining in this box");
            e.statusCode = 400;
            e.meta = { sachetsRemaining: remaining, requested: Math.round(qty), boxUid };
            throw e;
          }

          const d = await tx.dispense.create({
            data: {
              visitId: createdVisit.id,
              quantitySachets: Math.round(qty),
              boxId: box.id,
              note,
            },
          });

          createdDispenses.push(d);

          await tx.box.update({
            where: { id: box.id },
            data: {
              sachetsRemaining: newRemaining,
              status: newRemaining === 0 ? "DISPENSED" : "IN_FACILITY",
            },
          });

          await tx.boxEvent.create({
            data: {
              boxId: box.id,
              type: "DISPENSE",
              performedByUserId: req.user.id,
              fromFacilityId: childCheck.facilityId,
              note: `Dispensed ${Math.round(qty)} sachets to child ${childCheck.uniqueChildNumber} (visit ${createdVisit.id}). Remaining: ${newRemaining}`,
            },
          });
        }

        return { visit: createdVisit, dispenses: createdDispenses };
      });

      const outVisit = addLegacyVisitFields(result.visit);
      const outDispenses = (result.dispenses || []).map((d) =>
        addLegacyDispenseFields(d, result.visit, childCheck)
      );

      return res.status(201).json({
        message: "Visit created",
        visit: { ...outVisit, dispenses: outDispenses },
      });
    } catch (err) {
      console.error(err);
      const status = err.statusCode || 500;
      const payload = { message: status === 500 ? "Server error" : String(err.message || err) };
      if (status === 500) payload.error = String(err.message || err);
      if (err.meta) payload.meta = err.meta;
      return res.status(status).json(payload);
    }
  }
);


router.patch(
  "/children/:childId/visits/:visitId",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const existingVisit = await prisma.childVisit.findUnique({
        where: { id: req.params.visitId },
        include: { dispenses: { include: { box: true } } },
      });

      if (!existingVisit || existingVisit.childId !== childCheck.id || existingVisit.facilityId !== childCheck.facilityId) {
        return res.status(404).json({ message: "Visit not found for this child" });
      }

      const body = req.body || {};

      let visitDate = existingVisit.visitDate;
      if (body.visitDate !== undefined && body.visitDate !== null && String(body.visitDate).trim() !== "") {
        const parsed = parseDateOrNull(body.visitDate);
        if (!parsed) {
          return res.status(400).json({ message: "visitDate must be a valid date (YYYY-MM-DD)" });
        }
        visitDate = parsed;
      }

      if (startOfDay(visitDate) < startOfDay(childCheck.enrollmentDate)) {
        return res.status(400).json({ message: "visitDate cannot be before the child's enrollmentDate" });
      }

      if (startOfDay(visitDate) > startOfDay(new Date())) {
        return res.status(400).json({ message: "visitDate cannot be in the future" });
      }

      let nextAppointmentDate = existingVisit.nextAppointmentDate;
      if (Object.prototype.hasOwnProperty.call(body, "nextAppointmentDate")) {
        nextAppointmentDate = null;
        if (body.nextAppointmentDate !== null && String(body.nextAppointmentDate).trim() !== "") {
          const parsedNext = parseDateOrNull(body.nextAppointmentDate);
          if (!parsedNext) {
            return res.status(400).json({ message: "nextAppointmentDate must be a valid date (YYYY-MM-DD)" });
          }
          nextAppointmentDate = parsedNext;
        }
      }

      if (nextAppointmentDate && startOfDay(nextAppointmentDate) < startOfDay(visitDate)) {
        return res.status(400).json({ message: "nextAppointmentDate cannot be before visitDate" });
      }

      const sameDayOtherVisit = await findExistingVisitForSameChildAndDay(prisma, {
        childId: childCheck.id,
        facilityId: childCheck.facilityId,
        visitDate,
      });

      if (sameDayOtherVisit && sameDayOtherVisit.id !== existingVisit.id) {
        return res.status(409).json({
          message: `Another visit for this child already exists on ${formatDateOnly(visitDate)}. Choose a different date or edit that visit.`,
          existingVisit: addLegacyVisitFields(sameDayOtherVisit),
        });
      }

      const weightKg = Object.prototype.hasOwnProperty.call(body, "weightKg") || Object.prototype.hasOwnProperty.call(body, "weight")
        ? toNumberOrNull(body.weightKg ?? body.weight)
        : existingVisit.weightKg;
      const heightCm = Object.prototype.hasOwnProperty.call(body, "heightCm") || Object.prototype.hasOwnProperty.call(body, "height")
        ? toNumberOrNull(body.heightCm ?? body.height)
        : existingVisit.heightCm;
      const muacCandidate = Object.prototype.hasOwnProperty.call(body, "muacMm") || Object.prototype.hasOwnProperty.call(body, "muac")
        ? toNumberOrNull(body.muacMm ?? body.muac)
        : existingVisit.muacMm;
      const muacMm = Number.isFinite(muacCandidate) ? Math.round(muacCandidate) : null;
      const whzScore = Object.prototype.hasOwnProperty.call(body, "whzScore") || Object.prototype.hasOwnProperty.call(body, "whz")
        ? toNumberOrNull(body.whzScore ?? body.whz)
        : existingVisit.whzScore;
      const notes = Object.prototype.hasOwnProperty.call(body, "notes")
        ? (body.notes ? String(body.notes) : null)
        : existingVisit.notes;

      let newQuantitySachets = null;
      if (
        Object.prototype.hasOwnProperty.call(body, "quantitySachets") ||
        Object.prototype.hasOwnProperty.call(body, "sachetsDispensed") ||
        Object.prototype.hasOwnProperty.call(body, "sachetsGiven")
      ) {
        const qty = Number(body.quantitySachets ?? body.sachetsDispensed ?? body.sachetsGiven);
        if (!Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ message: "quantitySachets must be a positive number" });
        }
        newQuantitySachets = Math.round(qty);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const latestVisit = await tx.childVisit.findUnique({
          where: { id: existingVisit.id },
          include: { dispenses: { include: { box: true } } },
        });

        if (!latestVisit) {
          const e = new Error("Visit not found for this child");
          e.statusCode = 404;
          throw e;
        }

        const updatedVisit = await tx.childVisit.update({
          where: { id: latestVisit.id },
          data: {
            visitDate,
            notes,
            weightKg,
            heightCm,
            muacMm,
            whzScore,
            nextAppointmentDate,
            performedByUserId: req.user.id,
          },
        });

        // Bump child.updatedAt so edited visits are visible to other devices via delta sync.
        await tx.child.update({
          where: { id: childCheck.id },
          data: { updatedAt: new Date() },
        });

        let dispenses = latestVisit.dispenses || [];
        let reversedDispenses = [];
        if (newQuantitySachets !== null) {
          reversedDispenses = await reverseVisitDispensesToStock(tx, {
            visit: latestVisit,
            performedByUserId: req.user.id,
            reason: "Visit details edited",
          });

          const allocated = await autoAllocateDispenseFromFacility(tx, {
            facilityId: childCheck.facilityId,
            performedByUserId: req.user.id,
            childUniqueNumber: childCheck.uniqueChildNumber,
            visitId: updatedVisit.id,
            quantitySachets: newQuantitySachets,
            note: notes || "Edited visit dispense",
          });
          dispenses = allocated.map((a) => a.dispense);
        }

        return { visit: updatedVisit, dispenses, reversedDispenses };
      });

      const outVisit = addLegacyVisitFields({ ...updated.visit, dispenses: updated.dispenses });
      const outDispenses = (updated.dispenses || []).map((d) => addLegacyDispenseFields(d, updated.visit, childCheck));

      return res.json({
        message: "Visit updated",
        visit: { ...outVisit, dispenses: outDispenses },
        reversedDispenses: updated.reversedDispenses,
      });
    } catch (err) {
      console.error(err);
      const status = err.statusCode || 500;
      const payload = { message: status === 500 ? "Server error" : String(err.message || err) };
      if (err.meta) payload.meta = err.meta;
      if (status === 500) payload.error = String(err.message || err);
      return res.status(status).json(payload);
    }
  }
);

router.post(
  "/children/:childId/dispense",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const body = req.body || {};
      const quantitySachets = Number(body.quantitySachets ?? body.sachetsGiven);

      if (!Number.isFinite(quantitySachets) || quantitySachets <= 0) {
        return res.status(400).json({ message: "quantitySachets (or sachetsGiven) must be a positive number" });
      }

      const visitIdRaw = body.visitId ?? body.childVisitId;
      const note = body.note ? String(body.note) : null;
      const boxUid = body.boxUid ? String(body.boxUid).trim() : null;

      let visit = null;

      if (visitIdRaw) {
        visit = await prisma.childVisit.findUnique({ where: { id: String(visitIdRaw) } });
        if (!visit || visit.childId !== childCheck.id) {
          return res.status(400).json({ message: "visitId is invalid for this child" });
        }
      } else {
        const today = new Date();

        const existingSameDayVisit = await findExistingVisitForSameChildAndDay(prisma, {
          childId: childCheck.id,
          facilityId: childCheck.facilityId,
          visitDate: today,
        });

        if (existingSameDayVisit) {
          visit = existingSameDayVisit;
        } else {
          visit = await prisma.childVisit.create({
            data: {
              childId: childCheck.id,
              facilityId: childCheck.facilityId,
              performedByUserId: req.user.id,
              visitDate: today,
              notes: "Auto-created visit for dispensing",
            },
          });
          await prisma.child.update({
            where: { id: childCheck.id },
            data: { updatedAt: new Date() },
          });
        }
      }

      if (!boxUid) {
        const dispenses = await prisma.$transaction(async (tx) => {
          const auto = await autoAllocateDispenseFromFacility(tx, {
            facilityId: childCheck.facilityId,
            performedByUserId: req.user.id,
            childUniqueNumber: childCheck.uniqueChildNumber,
            visitId: visit.id,
            quantitySachets: Math.round(quantitySachets),
            note,
          });
          await tx.child.update({
            where: { id: childCheck.id },
            data: { updatedAt: new Date() },
          });
          return auto.map((a) => a.dispense);
        });

        return res.status(201).json({
          message: "Dispense recorded",
          visit: addLegacyVisitFields(visit),
          dispense: dispenses.map((d) => addLegacyDispenseFields(d, visit, childCheck)),
        });
      }

      const box = await prisma.box.findUnique({ where: { boxUid } });
      if (!box) return res.status(404).json({ message: "Box not found" });

      if (box.currentFacilityId !== childCheck.facilityId || box.status !== "IN_FACILITY") {
        return res.status(400).json({
          message: "Box is not available IN_FACILITY in this facility for dispensing",
          currentStatus: box.status,
          currentFacilityId: box.currentFacilityId,
        });
      }

      const perBox = Number.isFinite(box.sachetsPerBox) ? box.sachetsPerBox : 600;
      const remaining = Number.isFinite(box.sachetsRemaining) ? box.sachetsRemaining : perBox;
      const newRemaining = remaining - Math.round(quantitySachets);
      if (newRemaining < 0) {
        return res.status(400).json({
          message: "Not enough sachets remaining in this box",
          sachetsRemaining: remaining,
          requested: Math.round(quantitySachets),
          boxUid,
        });
      }

      const dispense = await prisma.$transaction(async (tx) => {
        const d = await tx.dispense.create({
          data: {
            visitId: visit.id,
            quantitySachets: Math.round(quantitySachets),
            boxId: box.id,
            note,
          },
        });

        await tx.box.update({
          where: { id: box.id },
          data: {
            sachetsRemaining: newRemaining,
            status: newRemaining === 0 ? "DISPENSED" : "IN_FACILITY",
          },
        });

        await tx.boxEvent.create({
          data: {
            boxId: box.id,
            type: "DISPENSE",
            performedByUserId: req.user.id,
            fromFacilityId: childCheck.facilityId,
            note: `Dispensed ${Math.round(quantitySachets)} sachets to child ${childCheck.uniqueChildNumber} (visit ${visit.id}). Remaining: ${newRemaining}`,
          },
        });

        await tx.child.update({
          where: { id: childCheck.id },
          data: { updatedAt: new Date() },
        });

        return d;
      });

      return res.status(201).json({
        message: "Dispense recorded",
        visit: addLegacyVisitFields(visit),
        dispense: addLegacyDispenseFields(dispense, visit, childCheck),
      });
    } catch (err) {
      console.error(err);
      const status = err.statusCode || 500;
      const payload = { message: status === 500 ? "Server error" : String(err.message || err) };
      if (status === 500) payload.error = String(err.message || err);
      if (err.meta) payload.meta = err.meta;
      return res.status(status).json(payload);
    }
  }
);

router.get(
  "/caregivers/:caregiverId",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const caregiver = await prisma.caregiver.findUnique({
        where: { id: req.params.caregiverId },
        include: { children: { orderBy: { createdAt: "desc" } } },
      });

      if (!caregiver) return res.status(404).json({ message: "Caregiver not found" });

      if (req.user.role !== "SUPER_ADMIN") {
        if (!req.user.facilityId || caregiver.facilityId !== req.user.facilityId) {
          return res.status(403).json({ message: "Forbidden" });
        }
      }

      const children = caregiver.children.map((c) => ({
        ...addLegacyChildFields(c),
        ageInMonths: computeAgeInMonths(c.dateOfBirth),
      }));

      return res.json({ ...addLegacyCaregiverFields(caregiver), children });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.post(
  "/children/:childId/assessment",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const body = req.body || {};
      const assessmentType =
        normalizeAssessmentType(req.query.type ?? body.assessmentType ?? body.type) || "ENROLLMENT";

      const existing = await prisma.inDepthAssessment.findUnique({
        where: { childId_assessmentType: { childId: childCheck.id, assessmentType } },
      });
      if (existing) {
        return res.status(409).json({
          message: `In-depth assessment already exists for this child (${assessmentType})`,
          assessment: existing,
        });
      }

      const rawDate = body.assessmentDate ?? body.assessedAt;
      if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== "") {
        const parsed = parseDateOrNull(rawDate);
        if (!parsed) {
          return res.status(400).json({ message: "assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)" });
        }
      }

      const normalized = normalizeAssessmentPayload(body);
      if (!isPlainObject(normalized.data)) {
        return res.status(400).json({ message: "Assessment data must be an object (send { data: {...} })" });
      }

      const enrichedData = enrichAssessmentData(normalized.data);
      const quick = extractAssessmentQuickFields(enrichedData);

      const assessment = await prisma.inDepthAssessment.create({
        data: {
          childId: childCheck.id,
          facilityId: childCheck.facilityId,
          performedByUserId: req.user.id,
          assessmentType,
          assessmentDate: normalized.assessmentDate,
          data: enrichedData,
          ...quick,
        },
      });

      return res.status(201).json({ message: "In-depth assessment saved", assessment: addLegacyAssessmentFields(assessment) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.get(
  "/children/:childId/assessment",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const assessmentType = normalizeAssessmentType(req.query.type) || "ENROLLMENT";

      const assessment = await prisma.inDepthAssessment.findUnique({
        where: { childId_assessmentType: { childId: childCheck.id, assessmentType } },
      });

      return res.json({
        assessmentType,
        assessment: assessment ? addLegacyAssessmentFields(assessment) : null,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.put(
  "/children/:childId/assessment",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const body = req.body || {};
      const assessmentType =
        normalizeAssessmentType(req.query.type ?? body.assessmentType ?? body.type) || "ENROLLMENT";

      const existing = await prisma.inDepthAssessment.findUnique({
        where: { childId_assessmentType: { childId: childCheck.id, assessmentType } },
      });
      if (!existing) {
        return res.status(404).json({
          message: `No in-depth assessment found for this child (${assessmentType})`,
        });
      }

      let assessmentDate = existing.assessmentDate;
      if (
        Object.prototype.hasOwnProperty.call(body, "assessmentDate") ||
        Object.prototype.hasOwnProperty.call(body, "assessedAt")
      ) {
        const d = parseDateOrNull(body.assessmentDate ?? body.assessedAt);
        if (!d) return res.status(400).json({ message: "assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)" });
        assessmentDate = d;
      }

      let dataObj = existing.data;
      if (Object.prototype.hasOwnProperty.call(body, "data")) {
        if (!isPlainObject(body.data)) {
          return res.status(400).json({ message: "Assessment data must be an object (send { data: {...} })" });
        }
        dataObj = body.data;
      } else {
        const { assessedAt: _a, assessmentDate: _b, ...rest } = body;
        if (Object.keys(rest).length) {
          if (!isPlainObject(rest)) return res.status(400).json({ message: "Assessment data must be an object" });
          dataObj = rest;
        }
      }

      dataObj = enrichAssessmentData(dataObj);
      const quick = extractAssessmentQuickFields(dataObj);

      const updated = await prisma.inDepthAssessment.update({
        where: { id: existing.id },
        data: {
          assessmentDate,
          data: dataObj,
          performedByUserId: req.user.id,
          ...quick,
        },
      });

      return res.json({ message: "In-depth assessment updated", assessment: addLegacyAssessmentFields(updated) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.get(
  "/facility/appointments",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const facility = await resolveFacilityForClinical(req, req.query || {});
      if (!facility) {
        return res.status(400).json({ message: "Your user has no facility assigned" });
      }

      const target = normalizeDateOnly(req.query.date || new Date());
      if (!target) {
        return res.status(400).json({ message: "date must be a valid date (YYYY-MM-DD)" });
      }

      const children = await prisma.child.findMany({
        where: { facilityId: facility.id },
        include: {
          caregiver: true,
          facility: true,
          inDepthAssessments: { orderBy: { assessmentDate: "desc" } },
          visits: {
            orderBy: { visitDate: "desc" },
            include: {
              dispenses: {
                orderBy: { createdAt: "desc" },
                include: { box: true },
              },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 1000,
      });

      const today = startOfDay(new Date());
      const rows = [];

      for (const child of children) {
        const enrollmentAssessment =
          (child.inDepthAssessments || []).find((a) => a.assessmentType === "ENROLLMENT") || null;

        const visits = (child.visits || []).map((v) => {
          const dispenses = (v.dispenses || []).map((d) => addLegacyDispenseFields(d, v, child));
          const enrichedVisit = enrichVisitFromAssessmentIfNeeded({ ...v, dispenses }, enrollmentAssessment);
          return addLegacyVisitFields(enrichedVisit);
        });

        const latestAppointmentVisit = deriveLatestAppointmentVisit(visits);
        if (!latestAppointmentVisit || !sameDay(latestAppointmentVisit.nextAppointmentDate, target)) {
          continue;
        }

        const seen = (child.visits || []).some((v) => sameDay(v.visitDate, target));

        let status = "upcoming";
        if (seen) {
          status = "honoured";
        } else if (target < today) {
          status = "missed";
        }

        rows.push({
          status,
          child: {
            id: child.id,
            uniqueChildNumber: child.uniqueChildNumber,
            firstName: child.firstName,
            lastName: child.lastName,
            sex: child.sex,
            dateOfBirth: child.dateOfBirth,
            cwcNumber: child.cwcNumber,
            enrollmentDate: child.enrollmentDate,
            caregiver: addLegacyCaregiverFields(child.caregiver),
            facility: child.facility ? { id: child.facility.id, code: child.facility.code, name: child.facility.name } : null,
            facilityCode: child.facility?.code,
          },
          latestAppointmentVisit,
          latestVisit: visits[0] || null,
          remoteChildId: child.id,
        });
      }

      rows.sort((a, b) => {
        const an = `${a.child?.firstName || ""} ${a.child?.lastName || ""}`.trim().toLowerCase();
        const bn = `${b.child?.firstName || ""} ${b.child?.lastName || ""}`.trim().toLowerCase();
        return an.localeCompare(bn);
      });

      return res.json({
        facility: { id: facility.id, code: facility.code, name: facility.name },
        date: formatDateOnly(target),
        count: rows.length,
        rows,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

router.get(
  "/facility/children/recent",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const facility = await resolveFacilityForClinical(req, req.query || {});
      if (!facility) {
        return res.status(400).json({ message: "Your user has no facility assigned" });
      }

      const takeRaw = Number(req.query.take || 50);
      const take = Number.isFinite(takeRaw) ? Math.max(1, Math.min(500, Math.round(takeRaw))) : 50;

      const target = req.query.date ? normalizeDateOnly(req.query.date) : null;
      if (req.query.date && !target) {
        return res.status(400).json({ message: "date must be a valid date (YYYY-MM-DD)" });
      }

      const children = await prisma.child.findMany({
        where: { facilityId: facility.id },
        include: {
          caregiver: true,
          facility: true,
          visits: {
            orderBy: { visitDate: "desc" },
            include: { dispenses: { orderBy: { createdAt: "desc" } } },
          },
          inDepthAssessments: { orderBy: { assessmentDate: "desc" } },
        },
        orderBy: { updatedAt: "desc" },
        take: 1000,
      });

      const rows = [];

      for (const child of children) {
        const actualVisits = child.visits || [];
        const assessments = child.inDepthAssessments || [];

        const matchingVisit = target
          ? actualVisits.find((v) => sameDay(v.visitDate, target))
          : actualVisits[0] || null;

        const matchingAssessment = target
          ? assessments.find((a) => sameDay(a.assessmentDate, target))
          : assessments[0] || null;

        const isEnrollmentToday = target ? sameDay(child.enrollmentDate, target) : false;

        if (target && !matchingVisit && !matchingAssessment && !isEnrollmentToday) {
          continue;
        }

        const activityDate =
          matchingVisit?.visitDate ||
          matchingAssessment?.assessmentDate ||
          child.enrollmentDate ||
          child.createdAt;

        const latestAppointmentVisit = deriveLatestAppointmentVisit(
          actualVisits.map((v) => addLegacyVisitFields(v))
        );

        rows.push({
          activityDate,
          child: {
            id: child.id,
            uniqueChildNumber: child.uniqueChildNumber,
            firstName: child.firstName,
            lastName: child.lastName,
            sex: child.sex,
            dateOfBirth: child.dateOfBirth,
            cwcNumber: child.cwcNumber,
            enrollmentDate: child.enrollmentDate,
            caregiver: addLegacyCaregiverFields(child.caregiver),
            facility: child.facility ? { id: child.facility.id, code: child.facility.code, name: child.facility.name } : null,
            facilityCode: child.facility?.code,
          },
          visit: matchingVisit ? addLegacyVisitFields(matchingVisit) : null,
          assessment: matchingAssessment ? addLegacyAssessmentFields(matchingAssessment) : null,
          latestAppointmentVisit: latestAppointmentVisit || null,
          remoteChildId: child.id,
          hasVisitToday: !!matchingVisit,
          hasAssessmentToday: !!matchingAssessment,
          enrolledToday: isEnrollmentToday,
        });
      }

      rows.sort((a, b) => compareDescByDate(a.activityDate, b.activityDate));

      return res.json({
        facility: { id: facility.id, code: facility.code, name: facility.name },
        date: target ? formatDateOnly(target) : null,
        count: rows.length > take ? take : rows.length,
        rows: rows.slice(0, take),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);


router.get(
  "/facility/sync-delta",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const facility = await resolveFacilityForClinical(req, req.query || {});
      if (!facility) {
        return res.status(400).json({ message: "Your user has no facility assigned" });
      }

      const serverTime = new Date();
      const takeRaw = Number(req.query.take || 500);
      const take = Number.isFinite(takeRaw) ? Math.max(1, Math.min(1000, Math.round(takeRaw))) : 500;

      let since = null;
      if (req.query.since !== undefined && req.query.since !== null && String(req.query.since).trim() !== "") {
        since = parseDateOrNull(req.query.since);
        if (!since) {
          return res.status(400).json({ message: "since must be a valid ISO date/time" });
        }
      }

      const where = { facilityId: facility.id };

      if (since) {
        const changedVisitChildIds = await prisma.childVisit.findMany({
          where: {
            facilityId: facility.id,
            OR: [
              { createdAt: { gt: since } },
              { visitDate: { gt: since } },
            ],
          },
          select: { childId: true },
          distinct: ["childId"],
          take,
        });

        const changedAssessmentChildIds = await prisma.inDepthAssessment.findMany({
          where: {
            facilityId: facility.id,
            OR: [
              { createdAt: { gt: since } },
              { updatedAt: { gt: since } },
              { assessmentDate: { gt: since } },
            ],
          },
          select: { childId: true },
          distinct: ["childId"],
          take,
        });

        const changedChildIds = [
          ...changedVisitChildIds.map((v) => v.childId),
          ...changedAssessmentChildIds.map((a) => a.childId),
        ];

        where.OR = [
          { updatedAt: { gt: since } },
          { createdAt: { gt: since } },
        ];

        if (changedChildIds.length) {
          where.OR.push({ id: { in: Array.from(new Set(changedChildIds)) } });
        }
      }

      const changedChildren = await prisma.child.findMany({
        where,
        select: { id: true, updatedAt: true, createdAt: true },
        orderBy: { updatedAt: "desc" },
        take,
      });

      const children = [];
      for (const row of changedChildren) {
        const summary = await buildChildSummaryPayload(row.id);
        if (summary) children.push(summary);
      }

      return res.json({
        facility: { id: facility.id, code: facility.code, name: facility.name },
        since: since ? since.toISOString() : null,
        serverTime: serverTime.toISOString(),
        count: children.length,
        children,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

module.exports = router;