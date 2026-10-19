-- Building type and size per warehouse, for the 3D warehouse view.

-- AlterTable
ALTER TABLE `Facility` ADD COLUMN `lengthM` DECIMAL(7, 2) NULL,
    ADD COLUMN `structureType` VARCHAR(191) NULL,
    ADD COLUMN `widthM` DECIMAL(7, 2) NULL;

