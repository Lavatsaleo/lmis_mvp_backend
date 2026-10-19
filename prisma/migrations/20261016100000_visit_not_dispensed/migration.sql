-- Enrollment no longer fails when the facility is out of stock: the child is
-- enrolled, nothing is dispensed, and the visit records why. These columns feed
-- the "children not dispensed" report. Additive and nullable.

ALTER TABLE `ChildVisit` ADD COLUMN `sachetsPrescribed` INTEGER NULL;
ALTER TABLE `ChildVisit` ADD COLUMN `notDispensedReason` VARCHAR(191) NULL;
CREATE INDEX `ChildVisit_notDispensedReason_idx` ON `ChildVisit`(`notDispensedReason`);
