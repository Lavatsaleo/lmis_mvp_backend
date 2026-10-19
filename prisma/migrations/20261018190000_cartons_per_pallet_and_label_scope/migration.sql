-- Cartons per pallet per product; which warehouses may generate QR labels.

-- AlterTable
ALTER TABLE `Implementation` ADD COLUMN `labelGenerationScope` VARCHAR(191) NOT NULL DEFAULT 'ALL_WAREHOUSES';

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `cartonsPerPallet` INTEGER NULL;

