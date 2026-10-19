-- Idempotency for box generation (POST /api/orders/:orderId/boxes/generate).
-- Boxes record the idempotency key of the request that created them, so a retry
-- after a client timeout returns the existing boxes instead of a duplicate set.
-- Additive and nullable: existing boxes keep NULL.

ALTER TABLE `Box` ADD COLUMN `generationRequestId` VARCHAR(191) NULL;
CREATE INDEX `Box_generationRequestId_idx` ON `Box`(`generationRequestId`);
