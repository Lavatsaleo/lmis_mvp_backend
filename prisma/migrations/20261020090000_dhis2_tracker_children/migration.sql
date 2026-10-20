-- CreateTable
CREATE TABLE `Dhis2TrackerProgram` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `programId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `commodity` VARCHAR(191) NULL,
    `startDate` DATETIME(3) NULL,
    `mapping` JSON NOT NULL,
    `labels` JSON NULL,
    `pullCursor` DATETIME(3) NULL,
    `lastPullAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Dhis2TrackerProgram_implementationId_programId_key`(`implementationId`, `programId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dhis2Child` (
    `id` VARCHAR(191) NOT NULL,
    `programConfigId` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `trackedEntityUid` VARCHAR(191) NOT NULL,
    `enrollmentUid` VARCHAR(191) NOT NULL,
    `orgUnitUid` VARCHAR(191) NOT NULL,
    `orgUnitName` VARCHAR(191) NULL,
    `orgUnitParentName` VARCHAR(191) NULL,
    `countyName` VARCHAR(191) NULL,
    `facilityId` VARCHAR(191) NULL,
    `patientId` VARCHAR(191) NULL,
    `childName` VARCHAR(191) NULL,
    `caregiverName` VARCHAR(191) NULL,
    `sex` VARCHAR(191) NULL,
    `dateOfBirth` DATETIME(3) NULL,
    `ageMonths` INTEGER NULL,
    `addressPayam` VARCHAR(191) NULL,
    `addressVillage` VARCHAR(191) NULL,
    `enrolledAt` DATETIME(3) NULL,
    `enrollmentStatus` VARCHAR(191) NULL,
    `admissionType` VARCHAR(191) NULL,
    `outcome` VARCHAR(191) NULL,
    `outcomeDate` DATETIME(3) NULL,
    `visitCount` INTEGER NOT NULL DEFAULT 0,
    `lastVisitDate` DATETIME(3) NULL,
    `nextVisitDate` DATETIME(3) NULL,
    `sachetsTotal` INTEGER NOT NULL DEFAULT 0,
    `lastWeightKg` DOUBLE NULL,
    `lastMuacCm` DOUBLE NULL,
    `lastWhz` DOUBLE NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,
    `dhis2UpdatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Dhis2Child_enrollmentUid_key`(`enrollmentUid`),
    INDEX `Dhis2Child_implementationId_programConfigId_idx`(`implementationId`, `programConfigId`),
    INDEX `Dhis2Child_orgUnitUid_idx`(`orgUnitUid`),
    INDEX `Dhis2Child_facilityId_idx`(`facilityId`),
    INDEX `Dhis2Child_patientId_idx`(`patientId`),
    INDEX `Dhis2Child_enrolledAt_idx`(`enrolledAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Dhis2ChildVisit` (
    `id` VARCHAR(191) NOT NULL,
    `childId` VARCHAR(191) NOT NULL,
    `eventUid` VARCHAR(191) NOT NULL,
    `stage` VARCHAR(191) NOT NULL,
    `programStageUid` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `weightKg` DOUBLE NULL,
    `heightCm` DOUBLE NULL,
    `muacCm` DOUBLE NULL,
    `whz` DOUBLE NULL,
    `oedema` VARCHAR(191) NULL,
    `sachets` INTEGER NULL,
    `nutritionStatus` VARCHAR(191) NULL,
    `visitStatus` VARCHAR(191) NULL,
    `nextVisitDate` DATETIME(3) NULL,
    `outcome` VARCHAR(191) NULL,
    `dataValues` JSON NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,
    `dhis2UpdatedAt` DATETIME(3) NULL,

    UNIQUE INDEX `Dhis2ChildVisit_eventUid_key`(`eventUid`),
    INDEX `Dhis2ChildVisit_childId_idx`(`childId`),
    INDEX `Dhis2ChildVisit_occurredAt_idx`(`occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Dhis2TrackerProgram` ADD CONSTRAINT `Dhis2TrackerProgram_implementationId_fkey` FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2Child` ADD CONSTRAINT `Dhis2Child_programConfigId_fkey` FOREIGN KEY (`programConfigId`) REFERENCES `Dhis2TrackerProgram`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Dhis2ChildVisit` ADD CONSTRAINT `Dhis2ChildVisit_childId_fkey` FOREIGN KEY (`childId`) REFERENCES `Dhis2Child`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

