-- AlterTable
ALTER TABLE `Dhis2Child` ADD COLUMN `commodityTotals` JSON NULL;

-- AlterTable
ALTER TABLE `Dhis2ChildVisit` ADD COLUMN `commodities` JSON NULL,
    ADD COLUMN `treatment` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Dhis2VisitCommodity` (
    `id` VARCHAR(191) NOT NULL,
    `visitId` VARCHAR(191) NOT NULL,
    `childId` VARCHAR(191) NOT NULL,
    `programConfigId` VARCHAR(191) NOT NULL,
    `commodity` VARCHAR(191) NOT NULL,
    `unit` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `occurredAt` DATETIME(3) NULL,

    INDEX `Dhis2VisitCommodity_visitId_idx`(`visitId`),
    INDEX `Dhis2VisitCommodity_childId_idx`(`childId`),
    INDEX `Dhis2VisitCommodity_programConfigId_commodity_idx`(`programConfigId`, `commodity`),
    INDEX `Dhis2VisitCommodity_occurredAt_idx`(`occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Dhis2VisitCommodity` ADD CONSTRAINT `Dhis2VisitCommodity_visitId_fkey` FOREIGN KEY (`visitId`) REFERENCES `Dhis2ChildVisit`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2VisitCommodity` ADD CONSTRAINT `Dhis2VisitCommodity_childId_fkey` FOREIGN KEY (`childId`) REFERENCES `Dhis2Child`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

