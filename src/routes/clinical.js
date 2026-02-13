const express = require("express");
const router = express.Router();

const prisma = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/rbac");

// ---------------- helpers ----------------
function computeAgeInMonths(dob) {
  const d = new Date(dob);
  const now = new Date();
  let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) months -= 1;
  return Math.max(0, months);
}

function buildUniqueChildNumber({ facilityCode, cwcNumber, yearOfBirth, program }) {
  return `${facilityCode}-${cwcNumber}-${yearOfBirth}-${program}`.toUpperCase();
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
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

function addLegacyVisitFields(visit) {
  if (!visit) return visit;
  return {
    ...visit,
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

      const program = body.program ? String(body.program).toUpperCase() : "SQLNS";
      if (program !== "SQLNS") {
        return res.status(400).json({ message: "Only program SQLNS is supported for now" });
      }

      const uniqueChildNumber = buildUniqueChildNumber({
        facilityCode: facility.code,
        cwcNumber,
        yearOfBirth: dob.getFullYear(),
        program,
      });

      // Prevent duplicate child unique number
      const existingChild = await prisma.child.findFirst({
        where: { uniqueChildNumber },
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
              assessmentDate: baselineAssessmentInput.assessmentDate,
              data: baselineAssessmentInput.data,

              ...quick,
            },
          });
        }

        return { caregiver, child, assessment };
      });

      return res.status(201).json({
        message: "Enrollment successful",
        facility: { id: facility.id, code: facility.code, name: facility.name },
        caregiver: addLegacyCaregiverFields(created.caregiver),
        child: addLegacyChildFields(created.child),
        assessment: addLegacyAssessmentFields(created.assessment),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
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

      const child = await prisma.child.findUnique({
        where: { id: req.params.childId },
        include: {
          caregiver: true,
          inDepthAssessment: true,
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

      const visits = (child.visits || []).map((v) => {
        const dispenses = (v.dispenses || []).map((d) => addLegacyDispenseFields(d, v, child));
        return addLegacyVisitFields({ ...v, dispenses });
      });

      const outChild = addLegacyChildFields({
        ...child,
        caregiver: addLegacyCaregiverFields(child.caregiver),
        inDepthAssessment: addLegacyAssessmentFields(child.inDepthAssessment),
        visits,
      });

      return res.json({
        ...outChild,
        ageInMonths: computeAgeInMonths(child.dateOfBirth),
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

      const visit = await prisma.childVisit.create({
        data: {
          childId: childCheck.id,
          facilityId: childCheck.facilityId,
          performedByUserId: req.user.id,
          visitDate,
          notes: body.notes ? String(body.notes) : null,
        },
      });

      return res.status(201).json({ message: "Visit created", visit: addLegacyVisitFields(visit) });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
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

      // 2) Validate box if provided
      let box = null;
      if (boxUid) {
        box = await prisma.box.findUnique({ where: { boxUid } });
        if (!box) return res.status(404).json({ message: "Box not found" });

        if (box.currentFacilityId !== childCheck.facilityId || box.status !== "IN_FACILITY") {
          return res.status(400).json({
            message: "Box is not available IN_FACILITY in this facility for dispensing",
            currentStatus: box.status,
            currentFacilityId: box.currentFacilityId,
          });
        }
      }

      const dispense = await prisma.$transaction(async (tx) => {
        const d = await tx.dispense.create({
          data: {
            visitId: visit.id,
            quantitySachets: Math.round(quantitySachets),
            boxId: box ? box.id : null,
            note,
          },
        });

        if (box) {
          await tx.box.update({
            where: { id: box.id },
            data: { status: "DISPENSED" },
          });

          await tx.boxEvent.create({
            data: {
              boxId: box.id,
              type: "DISPENSE",
              performedByUserId: req.user.id,
              fromFacilityId: childCheck.facilityId,
              note: `Dispensed to child ${childCheck.uniqueChildNumber} (visit ${visit.id})`,
            },
          });
        }

        return d;
      });

      return res.status(201).json({
        message: "Dispense recorded",
        visit: addLegacyVisitFields(visit),
        dispense: addLegacyDispenseFields(dispense, visit, childCheck),
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Server error", error: String(err.message || err) });
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

      const existing = await prisma.inDepthAssessment.findUnique({
        where: { childId: childCheck.id },
      });
      if (existing) {
        return res
          .status(409)
          .json({ message: "In-depth assessment already exists for this child", assessment: existing });
      }

      // strict date validation if client provides one
      const rawDate = (req.body || {}).assessmentDate ?? (req.body || {}).assessedAt;
      if (rawDate !== undefined && rawDate !== null && String(rawDate).trim() !== "") {
        const parsed = parseDateOrNull(rawDate);
        if (!parsed) {
          return res.status(400).json({ message: "assessmentDate (or assessedAt) must be a valid date (YYYY-MM-DD)" });
        }
      }

      const normalized = normalizeAssessmentPayload(req.body || {});
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

      const assessment = await prisma.inDepthAssessment.findUnique({
        where: { childId: childCheck.id },
      });

      return res.json({ assessment: assessment ? addLegacyAssessmentFields(assessment) : null });
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

      const existing = await prisma.inDepthAssessment.findUnique({
        where: { childId: childCheck.id },
      });
      if (!existing) return res.status(404).json({ message: "No in-depth assessment found for this child" });

      const body = req.body || {};

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
