-- Pre-deployment check for the production database. READ ONLY: it only runs
-- SELECT statements and changes nothing.
--
-- Run on the server BEFORE `prisma migrate deploy`, and keep the output:
--   mysql -h <host> -u <user> -p --force --table <database> < scripts/predeploy-check.sql > predeploy-before.txt
-- Run it again AFTER the upgrade (predeploy-after.txt): section 6 must match.
--
-- Written for the schema production runs today (4 migrations applied, no
-- Country / Implementation tables yet), so it uses no newer columns.

-- =====================================================================
-- 1. SERVER and table-name case (lower_case_table_names = 0 means the
--    names below must be exactly Box, Facility, Order, User...)
-- =====================================================================
SELECT VERSION() AS mysql_version, @@lower_case_table_names AS lower_case_table_names,
       DATABASE() AS database_name, @@character_set_database AS charset, @@collation_database AS collation;

SELECT table_name AS table_name_exact_case FROM information_schema.tables
WHERE table_schema = DATABASE() ORDER BY table_name;

-- =====================================================================
-- 2. MIGRATIONS already applied (expect 4, none with finished_at NULL)
-- =====================================================================
SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
FROM `_prisma_migrations` ORDER BY started_at;

-- =====================================================================
-- 3. USERS
-- =====================================================================
-- 3a. Who exists, per role
SELECT role, SUM(isActive = 1) AS active, SUM(isActive = 0) AS disabled FROM `User` GROUP BY role ORDER BY role;

-- 3b. Super admins (keep at least one you can sign in with)
SELECT email, isActive, lastLoginAt FROM `User` WHERE role = 'SUPER_ADMIN';

-- 3c. Roles that need a location but have none
SELECT email, role FROM `User`
WHERE isActive = 1 AND facilityId IS NULL AND role IN ('WAREHOUSE_OFFICER', 'FACILITY_OFFICER', 'CLINICIAN');

-- 3d. Location of the wrong kind for the role
SELECT u.email, u.role, f.code AS location, f.type AS location_type
FROM `User` u JOIN `Facility` f ON f.id = u.facilityId
WHERE u.isActive = 1
  AND ((u.role = 'WAREHOUSE_OFFICER' AND f.type <> 'WAREHOUSE')
    OR (u.role IN ('FACILITY_OFFICER', 'CLINICIAN') AND f.type <> 'FACILITY'));

-- 3e. Same email twice once case and spaces are ignored
SELECT LOWER(TRIM(email)) AS email_normalised, COUNT(*) AS accounts
FROM `User` GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1;

-- 3f. Active in the last 14 days: their phones may hold unsynced work.
SELECT email, role, lastLoginAt FROM `User`
WHERE isActive = 1 AND lastLoginAt >= NOW() - INTERVAL 14 DAY ORDER BY lastLoginAt DESC;

-- =====================================================================
-- 4. LOCATIONS AND PRODUCTS
-- =====================================================================
SELECT type, COUNT(*) AS locations FROM `Facility` GROUP BY type;

-- Facilities not linked to a warehouse (cannot receive shipments)
SELECT code, name FROM `Facility` WHERE type = 'FACILITY' AND warehouseId IS NULL;

SELECT id, code, name FROM `Product`;

-- =====================================================================
-- 5. DONOR NAMES on orders (the upgrade makes one Donor per distinct
--    name; check for near-duplicates such as "UNICEF" / "Unicef ")
-- =====================================================================
SELECT TRIM(o.donorName) AS donor_name, COUNT(*) AS boxes
FROM `Box` b JOIN `Order` o ON o.id = b.orderId
WHERE o.donorName IS NOT NULL AND TRIM(o.donorName) <> ''
GROUP BY TRIM(o.donorName) ORDER BY donor_name;

-- =====================================================================
-- 6. SNAPSHOT (exact counts) to compare after the upgrade
-- =====================================================================
SELECT status, COUNT(*) AS boxes, SUM(sachetsRemaining) AS sachets_remaining
FROM `Box` GROUP BY status ORDER BY status;

SELECT status, COUNT(*) AS shipments FROM `Shipment` GROUP BY status;

SELECT (SELECT COUNT(*) FROM `User`) AS users,
       (SELECT COUNT(*) FROM `Facility`) AS locations,
       (SELECT COUNT(*) FROM `Product`) AS products,
       (SELECT COUNT(*) FROM `Order`) AS orders,
       (SELECT COUNT(*) FROM `Box`) AS boxes,
       (SELECT COUNT(*) FROM `BoxEvent`) AS box_events,
       (SELECT COUNT(*) FROM `Shipment`) AS shipments,
       (SELECT COUNT(*) FROM `ShipmentItem`) AS shipment_items,
       (SELECT COUNT(*) FROM `Caregiver`) AS caregivers,
       (SELECT COUNT(*) FROM `Child`) AS children,
       (SELECT COUNT(*) FROM `ChildVisit`) AS visits,
       (SELECT COUNT(*) FROM `Dispense`) AS dispenses,
       (SELECT COUNT(*) FROM `InDepthAssessment`) AS assessments,
       (SELECT COUNT(*) FROM `DuplicateCase`) AS duplicate_cases;

SELECT MAX(createdAt) AS last_box_event FROM `BoxEvent`;
SELECT MAX(createdAt) AS last_visit FROM `ChildVisit`;
