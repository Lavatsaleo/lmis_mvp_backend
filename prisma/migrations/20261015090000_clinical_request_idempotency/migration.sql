-- Idempotency keys for offline-synced clinical writes.
--
-- The mobile app sends its queue id with every queued request. Storing it with a
-- unique index means a retried or duplicated request (lost response, two sync
-- runs at once) is recognised as a replay instead of creating a second child or
-- visit and dispensing stock twice. Additive and nullable: existing rows keep NULL.

ALTER TABLE `Child` ADD COLUMN `clientRequestId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `Child_clientRequestId_key` ON `Child`(`clientRequestId`);

ALTER TABLE `ChildVisit` ADD COLUMN `clientRequestId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `ChildVisit_clientRequestId_key` ON `ChildVisit`(`clientRequestId`);
