-- DHIS2 integration: org unit per site, config, imported visit events,
-- non-clinical stock consumption, sync runs. Additive.

-- AlterTable
ALTER TABLE `Facility` ADD COLUMN `dhis2OrgUnitId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Dhis2Config` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `programId` VARCHAR(191) NULL,
    `programName` VARCHAR(191) NULL,
    `programStageId` VARCHAR(191) NULL,
    `dispenseDataElementId` VARCHAR(191) NULL,
    `dispenseDataElementName` VARCHAR(191) NULL,
    `dispenseProductId` VARCHAR(191) NULL,
    `countStatuses` VARCHAR(191) NOT NULL DEFAULT 'ACTIVE,COMPLETED',
    `startDate` DATETIME(3) NULL,
    `stockPeriodType` VARCHAR(191) NOT NULL DEFAULT 'Daily',
    `intervalMinutes` INTEGER NOT NULL DEFAULT 60,
    `pullCursor` DATETIME(3) NULL,
    `lastPullAt` DATETIME(3) NULL,
    `lastPushAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Dhis2Config_implementationId_key`(`implementationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dhis2StockElement` (
    `id` VARCHAR(191) NOT NULL,
    `configId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `boxesDataElementId` VARCHAR(191) NULL,
    `sachetsDataElementId` VARCHAR(191) NULL,

    UNIQUE INDEX `Dhis2StockElement_configId_productId_key`(`configId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dhis2EventImport` (
    `id` VARCHAR(191) NOT NULL,
    `eventUid` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `orgUnitId` VARCHAR(191) NOT NULL,
    `facilityId` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NULL,
    `dhis2UpdatedAt` DATETIME(3) NULL,
    `status` VARCHAR(191) NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,
    `reportedSachets` INTEGER NOT NULL DEFAULT 0,
    `deductedSachets` INTEGER NOT NULL DEFAULT 0,
    `shortfallSachets` INTEGER NOT NULL DEFAULT 0,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Dhis2EventImport_eventUid_key`(`eventUid`),
    INDEX `Dhis2EventImport_implementationId_facilityId_idx`(`implementationId`, `facilityId`),
    INDEX `Dhis2EventImport_orgUnitId_idx`(`orgUnitId`),
    INDEX `Dhis2EventImport_shortfallSachets_idx`(`shortfallSachets`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockConsumption` (
    `id` VARCHAR(191) NOT NULL,
    `facilityId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `sachets` INTEGER NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'DHIS2',
    `occurredAt` DATETIME(3) NOT NULL,
    `eventImportId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StockConsumption_facilityId_occurredAt_idx`(`facilityId`, `occurredAt`),
    INDEX `StockConsumption_eventImportId_idx`(`eventImportId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockConsumptionLine` (
    `id` VARCHAR(191) NOT NULL,
    `consumptionId` VARCHAR(191) NOT NULL,
    `boxId` VARCHAR(191) NOT NULL,
    `sachets` INTEGER NOT NULL,

    INDEX `StockConsumptionLine_consumptionId_idx`(`consumptionId`),
    INDEX `StockConsumptionLine_boxId_idx`(`boxId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dhis2SyncRun` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `direction` VARCHAR(191) NOT NULL,
    `trigger` VARCHAR(191) NOT NULL DEFAULT 'SCHEDULE',
    `status` VARCHAR(191) NOT NULL DEFAULT 'RUNNING',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `stats` JSON NULL,
    `error` TEXT NULL,

    INDEX `Dhis2SyncRun_implementationId_startedAt_idx`(`implementationId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Facility_dhis2OrgUnitId_idx` ON `Facility`(`dhis2OrgUnitId`);

-- AddForeignKey
ALTER TABLE `Dhis2Config` ADD CONSTRAINT `Dhis2Config_implementationId_fkey` FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2StockElement` ADD CONSTRAINT `Dhis2StockElement_configId_fkey` FOREIGN KEY (`configId`) REFERENCES `Dhis2Config`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2StockElement` ADD CONSTRAINT `Dhis2StockElement_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2EventImport` ADD CONSTRAINT `Dhis2EventImport_facilityId_fkey` FOREIGN KEY (`facilityId`) REFERENCES `Facility`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockConsumption` ADD CONSTRAINT `StockConsumption_facilityId_fkey` FOREIGN KEY (`facilityId`) REFERENCES `Facility`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockConsumption` ADD CONSTRAINT `StockConsumption_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockConsumption` ADD CONSTRAINT `StockConsumption_eventImportId_fkey` FOREIGN KEY (`eventImportId`) REFERENCES `Dhis2EventImport`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockConsumptionLine` ADD CONSTRAINT `StockConsumptionLine_consumptionId_fkey` FOREIGN KEY (`consumptionId`) REFERENCES `StockConsumption`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockConsumptionLine` ADD CONSTRAINT `StockConsumptionLine_boxId_fkey` FOREIGN KEY (`boxId`) REFERENCES `Box`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

