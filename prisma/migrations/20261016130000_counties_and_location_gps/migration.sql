-- Configurable counties per implementation, plus county and GPS on stock
-- locations. Supports the South Sudan workflow: main warehouse -> county ->
-- field base (chosen from that county's bases) -> sites linked to the base.
-- Additive and nullable: existing (Kenya) locations are unaffected.

CREATE TABLE `County` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `County_implementationId_name_key`(`implementationId`, `name`),
    INDEX `County_implementationId_idx`(`implementationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `County` ADD CONSTRAINT `County_implementationId_fkey`
  FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `Facility`
  ADD COLUMN `countyId` VARCHAR(191) NULL,
  ADD COLUMN `latitude` DECIMAL(9, 6) NULL,
  ADD COLUMN `longitude` DECIMAL(9, 6) NULL;

CREATE INDEX `Facility_countyId_idx` ON `Facility`(`countyId`);

ALTER TABLE `Facility` ADD CONSTRAINT `Facility_countyId_fkey`
  FOREIGN KEY (`countyId`) REFERENCES `County`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
