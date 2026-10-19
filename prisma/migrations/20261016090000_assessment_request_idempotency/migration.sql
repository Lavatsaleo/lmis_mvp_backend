-- Idempotency key for in-depth assessments created via
-- POST /api/clinical/children/:childId/assessment (e.g. discharge from the
-- mobile sync queue). A retried request is answered with the original record
-- instead of a 409 that would park it in NEEDS_REVIEW. Additive and nullable.

ALTER TABLE `InDepthAssessment` ADD COLUMN `clientRequestId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `InDepthAssessment_clientRequestId_key` ON `InDepthAssessment`(`clientRequestId`);
