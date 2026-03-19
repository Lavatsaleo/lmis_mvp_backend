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


function startOfDay(value) {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(value) {
  const d = new Date(value);
  d.setHours(23, 59, 59, 999);
  return d;
}

function normalizeDateOnly(value) {
  const d = parseDateOrNull(value);
  if (!d) return null;
  return startOfDay(d);
}

function formatDateOnly(value) {
  const d = new Date(value);
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function compareDescByDate(a, b) {
  return new Date(b).getTime() - new Date(a).getTime();
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
    // if yes but missing freq, assume minimally 1
    if (!Number.isFinite(freq)) return 1;
    // Form uses: 1=Rarely, 2=Sometimes, 3=Often. HHS recode: rarely/sometimes=1, often=2
    if (freq === 3) return 2;
    return 1;
  };

  const s1 = scoreQuestion(q1, q1a);
  const s2 = scoreQuestion(q2, q2a);
  const s3 = scoreQuestion(q3, q3a);

  if ([s1, s2, s3].some((x) => x === null)) return null;

  const score = s1 + s2 + s3; // 0..6
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

  const score = q1 + q2 + q3 + q4 + q5; // 0..10
  let category = null;
  if (score <= 2) category = "Low psycho-social risk";
  else if (score <= 5) category = "Moderate distress";
  else category = "High psycho-social stress / Severe distress";

  return { score, category };
}

function enrichAssessmentData(data) {
  const obj = isPlainObject(data) ? { ...data } : {};
  const derived = isPlainObject(obj.derived) ? { ...obj.derived } : {};

  // HHS
  if (derived.hhsScore == null && derived.householdHungerScore == null) {
    const hhs = computeHhsFromData(obj);
    if (hhs) {
      derived.hhsScore = hhs.score;
      derived.hhsCategory = hhs.category;
      derived.householdHungerScore = hhs.score;
      derived.householdHungerCategory = hhs.category;
    }
  }

  // PSS
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

/**
 * Extract a few “fast query” fields from the assessment JSON.
 * We keep this defensive because your frontend field names may evolve.
 */
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
  return [visit.weightKg, visit.heightCm, visit.muacMm, visit.whzScore].some((v) => v !== null && v !== undefined && v !== "");
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

  // Try common paths (you can standardize later)
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
    // Heuristic: if it looks like cm (e.g., 11.5–20), convert to mm
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
  // SUPER_ADMIN may act on a facility using facilityCode
  if (req.user.role === "SUPER_ADMIN" && body.facilityCode) {
    return prisma.facility.findUnique({ where: { code: String(body.facilityCode).trim() } });
  }

  // Everyone else uses their assigned facility
  if (!req.user.facilityId) return null;
  return prisma.facility.findUnique({ where: { id: req.user.facilityId } });
}

async function assertChildInMyFacility(req, childId) {
  const child = await prisma.child.findUnique({ where: { id: childId } });
  if (!child) return null;

  // SUPER_ADMIN can access any facility
  if (req.user.role === "SUPER_ADMIN") return child;

  if (!req.user.facilityId) return null;
  if (child.facilityId !== req.user.facilityId) return "FORBIDDEN";
  return child;
}


async function buildChildSummaryForFacility(childId) {
  const child = await prisma.child.findUnique({
    where: { id: childId },
    include: {
      caregiver: true,
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

  return addLegacyChildFields({
    ...child,
    caregiver: addLegacyCaregiverFields(child.caregiver),
    inDepthAssessment: enrollmentAssessment ? addLegacyAssessmentFields(enrollmentAssessment) : null,
    inDepthAssessments: assessments,
    visits,
  });
}

function deriveLatestAppointmentVisit(visits) {
  return (visits || []).find((v) => v && v.nextAppointmentDate);
}

// ---------------- routes ----------------

/**
 * 1) Enroll child + caregiver (Option 1)
 * POST /api/clinical/enroll
 *
 * We keep your old request body keys working, but map them into the new Prisma schema.
 * OPTIONAL: include `inDepthAssessment` to save baseline assessment immediately.
 */
router.post(
  "/enroll",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN"),
  async (req, res) => {
    try {
      const body = req.body || {};

      // Backward compatible inputs (old UI) + allow newer keys
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
      if (body.enrollmentDate !== undefined && body.enrollmentDate !== null && String(body.enrollmentDate).trim() !== "") {
        const parsed = parseDateOrNull(body.enrollmentDate);
        if (!parsed) {
          return res.status(400).json({ message: "enrollmentDate must be a valid date (YYYY-MM-DD)" });
        }
        enrollmentDate = parsed;
      }


      // Program eligibility: only children aged 6–23 months can be enrolled
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

      // Prevent duplicates: same CWC number in the same facility (and also registration number)
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

      // Validate OPTIONAL baseline assessment *before* transaction (safer)
      let baselineAssessmentInput = null;
      if (body.inDepthAssessment != null) {
        if (!isPlainObject(body.inDepthAssessment)) {
          return res.status(400).json({ message: "inDepthAssessment must be an object" });
        }

        // strict validation: if a date was provided and it's invalid, fail
        const rawDate = body.inDepthAssessment.assessmentDate ?? body.inDepthAssessment.assessedAt;
        if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== "") {
          const parsed = parseDateOrNull(rawDate);
          if (!parsed) {
            return res.status(400).json({ message: "inDepthAssessment.assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)" });
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



      // OPTIONAL: initial dispense captured during enrollment assessment (visit)
      // The mobile app sends this under `visit` with at least `sachetsDispensed` and `nextAppointmentDate`.
      let enrollmentVisitInput = null;
      if (isPlainObject(body.visit)) {
        const v = body.visit;
        const sachets = Number(v.sachetsDispensed ?? v.quantitySachets ?? v.sachetsGiven);
        if (!Number.isFinite(sachets) || sachets <= 0) {
          return res.status(400).json({ message: "visit.sachetsDispensed must be a positive number" });
        }

        let nextAppointmentDate = null;
        if (v.nextAppointmentDate !== undefined && v.nextAppointmentDate !== null && String(v.nextAppointmentDate).trim() !== "") {
          const parsedNext = parseDateOrNull(v.nextAppointmentDate);
          if (!parsedNext) {
            return res.status(400).json({ message: "visit.nextAppointmentDate must be a valid date (YYYY-MM-DD)" });
          }
          nextAppointmentDate = parsedNext;
        }

        enrollmentVisitInput = {
          sachetsDispensed: Math.round(sachets),
          nextAppointmentDate,
          notes: v.notes ? String(v.notes) : null,
        };
      }
      const created = await prisma.$transaction(async (tx) => {
        // Find caregiver by same contacts in the SAME facility (MVP rule)
        let caregiver = await tx.caregiver.findFirst({
          where: {
            facilityId: facility.id,
            contacts: caregiverContacts,
          },
        });

        if (!caregiver) {
          caregiver = await tx.caregiver.create({
            data: {
              facilityId: facility.id,
              fullName: caregiverName,
              contacts: caregiverContacts,
              village,
            },
          });
        }

        const sex = body.sex ? String(body.sex).toUpperCase() : "UNKNOWN"; // schema requires String

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
        // OPTIONAL: baseline in-depth assessment saved immediately
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

        // OPTIONAL: record initial dispense during enrollment (no box scanning in the client)
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
              visitDate: baselineAssessmentInput?.assessmentDate ?? enrollmentDate,
              nextAppointmentDate: enrollmentVisitInput.nextAppointmentDate,
              notes: enrollmentVisitInput.notes ?? "Enrollment dispense",
              weightKg: baselineVisitMetrics.weightKg ?? null,
              heightCm: baselineVisitMetrics.heightCm ?? null,
              muacMm: baselineVisitMetrics.muacMm ?? null,
              whzScore: baselineVisitMetrics.whzScore ?? null,
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

        return { caregiver, child, assessment, enrollmentVisit, enrollmentDispenses };
      });

      return res.status(201).json({
        message: "Enrollment successful",
        facility: { id: facility.id, code: facility.code, name: facility.name },
        caregiver: addLegacyCaregiverFields(created.caregiver),
        child: addLegacyChildFields(created.child),
        assessment: addLegacyAssessmentFields(created.assessment),
        visit: created.enrollmentVisit ? addLegacyVisitFields(created.enrollmentVisit) : null,
        dispense: (created.enrollmentDispenses || []).map((d) => addLegacyDispenseFields(d, created.enrollmentVisit, created.child)),
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

/**
 * 2) Search children (by name, unique number, CWC number, caregiver contacts)
 * GET /api/clinical/children/search?q=
 */
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
        include: { caregiver: true },
        take: 50,
        orderBy: { createdAt: "desc" },
      });

      const out = children.map((c) => ({
        ...addLegacyChildFields({
          ...c,
          caregiver: addLegacyCaregiverFields(c.caregiver),
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


/**
 * 2b) Facility appointments diary (shared facility calendar)
 * GET /api/clinical/facility/appointments?date=YYYY-MM-DD
 */
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
        const status = seen
          ? "HONOURED"
          : target.getTime() <= today.getTime()
            ? "MISSED"
            : "UPCOMING";

        rows.push({
          appointmentDate: formatDateOnly(target),
          status,
          seen,
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
          },
          latestVisit: latestAppointmentVisit
            ? {
                id: latestAppointmentVisit.id,
                visitDate: latestAppointmentVisit.visitDate,
                nextAppointmentDate: latestAppointmentVisit.nextAppointmentDate,
                notes: latestAppointmentVisit.notes,
                sachetsDispensed: sumVisitSachets(latestAppointmentVisit),
              }
            : null,
        });
      }

      rows.sort((a, b) => {
        if (a.seen !== b.seen) return a.seen ? 1 : -1;
        const an = `${a.child.firstName} ${a.child.lastName}`.toLowerCase();
        const bn = `${b.child.firstName} ${b.child.lastName}`.toLowerCase();
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

/**
 * 2c) Recent child activity for my facility
 * GET /api/clinical/facility/children/recent?date=YYYY-MM-DD&take=50
 */
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
      const take = Number.isFinite(takeRaw) ? Math.max(1, Math.min(200, Math.round(takeRaw))) : 50;

      const target = req.query.date ? normalizeDateOnly(req.query.date) : null;
      if (req.query.date && !target) {
        return res.status(400).json({ message: "date must be a valid date (YYYY-MM-DD)" });
      }

      const children = await prisma.child.findMany({
        where: { facilityId: facility.id },
        include: {
          caregiver: true,
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

        const latestAppointmentVisit = deriveLatestAppointmentVisit(actualVisits.map((v) => addLegacyVisitFields(v)));

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
          },
          visit: matchingVisit
            ? {
                id: matchingVisit.id,
                visitDate: matchingVisit.visitDate,
                notes: matchingVisit.notes,
                nextAppointmentDate: matchingVisit.nextAppointmentDate,
                sachetsDispensed: (matchingVisit.dispenses || []).reduce(
                  (sum, d) => sum + Math.round(Number(d?.quantitySachets || 0)),
                  0
                ),
              }
            : null,
          latestAppointmentDate: latestAppointmentVisit?.nextAppointmentDate || null,
          hasAssessment: !!matchingAssessment,
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

/**
 * 3) Child summary
 * GET /api/clinical/children/:childId/summary
 */
router.get(
  "/children/:childId/summary",
  requireAuth,
  requireRole("SUPER_ADMIN", "CLINICIAN", "FACILITY_OFFICER", "VIEWER"),
  async (req, res) => {
    try {
      const childCheck = await assertChildInMyFacility(req, req.params.childId);
      if (!childCheck) return res.status(404).json({ message: "Child not found" });
      if (childCheck === "FORBIDDEN") return res.status(403).json({ message: "Forbidden" });

      const outChild = await buildChildSummaryForFacility(req.params.childId);
      if (!outChild) return res.status(404).json({ message: "Child not found" });

      return res.json({
        ...outChild,
        ageInMonths: computeAgeInMonths(outChild.dateOfBirth),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
    }
  }
);

/**
 * 4) Create follow-up visit
 * POST /api/clinical/children/:childId/visits
 */
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

      const weightKg = toNumberOrNull(body.weightKg ?? body.weight);
      const heightCm = toNumberOrNull(body.heightCm ?? body.height);

      const muacMmCandidate = toNumberOrNull(body.muacMm ?? body.muac);
      const muacMm = Number.isFinite(muacMmCandidate) ? Math.round(muacMmCandidate) : null;

      const whzScore = toNumberOrNull(body.whzScore ?? body.whz);

      // Optional next appointment date
      let nextAppointmentDate = null;
      if (
        body.nextAppointmentDate !== undefined &&
        body.nextAppointmentDate !== null &&
        String(body.nextAppointmentDate).trim() !== ""
      ) {
        const parsedNext = parseDateOrNull(body.nextAppointmentDate);
        if (!parsedNext) {
          return res
            .status(400)
            .json({ message: "nextAppointmentDate must be a valid date (YYYY-MM-DD)" });
        }
        nextAppointmentDate = parsedNext;
      }

      // Optional dispense payload:
      //  - either { quantitySachets, boxUid, dispenseNote }
      //  - or { dispenses: [{ quantitySachets, boxUid, note }, ...] }
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

            // Anthropometry + WHZ
            weightKg,
            heightCm,
            muacMm,
            whzScore,

            // Scheduling
            nextAppointmentDate,
          },
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

          // If client didn't scan a box, auto-allocate from facility stock (FEFO)
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

          // Update box sachet balance. Mark as DISPENSED only when empty.
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

/**
 * 5) Dispense sachets (optionally link QR boxUid)
 * POST /api/clinical/children/:childId/dispense
 *
 * Backward compatible request body keys:
 *  - sachetsGiven (old)
 *  - quantitySachets (new)
 *  - childVisitId (old)
 *  - visitId (new)
 */
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
      const quantitySachets =
        Number(body.quantitySachets ?? body.sachetsGiven);

      if (!Number.isFinite(quantitySachets) || quantitySachets <= 0) {
        return res.status(400).json({ message: "quantitySachets (or sachetsGiven) must be a positive number" });
      }

      const visitIdRaw = body.visitId ?? body.childVisitId;
      const note = body.note ? String(body.note) : null;
      const boxUid = body.boxUid ? String(body.boxUid).trim() : null;

      // 1) Resolve visit (schema requires a visitId). If none provided, auto-create a visit.
      let visit = null;
      if (visitIdRaw) {
        visit = await prisma.childVisit.findUnique({ where: { id: String(visitIdRaw) } });
        if (!visit || visit.childId !== childCheck.id) {
          return res.status(400).json({ message: "visitId is invalid for this child" });
        }
      } else {
        visit = await prisma.childVisit.create({
          data: {
            childId: childCheck.id,
            facilityId: childCheck.facilityId,
            performedByUserId: req.user.id,
            visitDate: new Date(),
            notes: "Auto-created visit for dispensing",
          },
        });
      }

      // If client didn't scan a box, auto-allocate from facility stock (FEFO)
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
          return auto.map((a) => a.dispense);
        });

        return res.status(201).json({
          message: "Dispense recorded",
          visit: addLegacyVisitFields(visit),
          dispense: dispenses.map((d) => addLegacyDispenseFields(d, visit, childCheck)),
        });
      }


      // 2) Validate box
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

/**
 * 6) Caregiver profile (show caregiver + children)
 * GET /api/clinical/caregivers/:caregiverId
 */
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

// ---------------- In-depth assessment (Option 1) ----------------

/**
 * 7) Create baseline In-Depth Assessment (one per child)
 * POST /api/clinical/children/:childId/assessment
 */
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

      // strict date validation if client provides one
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

/**
 * 8) Get in-depth assessment
 * GET /api/clinical/children/:childId/assessment
 */
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

/**
 * 9) Update in-depth assessment
 * PUT /api/clinical/children/:childId/assessment
 */
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

      // Only update date if provided
      let assessmentDate = existing.assessmentDate;
      if (Object.prototype.hasOwnProperty.call(body, "assessmentDate") || Object.prototype.hasOwnProperty.call(body, "assessedAt")) {
        const d = parseDateOrNull(body.assessmentDate ?? body.assessedAt);
        if (!d) return res.status(400).json({ message: "assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)" });
        assessmentDate = d;
      }

      // Data update
      let dataObj = existing.data;
      if (Object.prototype.hasOwnProperty.call(body, "data")) {
        if (!isPlainObject(body.data)) {
          return res.status(400).json({ message: "Assessment data must be an object (send { data: {...} })" });
        }
        dataObj = body.data;
      } else {
        // If they sent fields other than the date, store those as the new data
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
          performedByUserId: req.user.id, // last editor
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

module.exports = router;
