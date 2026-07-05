CREATE TABLE `DuplicateCase` (
  `id` VARCHAR(191) NOT NULL,
  `primaryChildId` VARCHAR(191) NOT NULL,
  `duplicateChildId` VARCHAR(191) NULL,
  `facilityId` VARCHAR(191) NULL,
  `matchingFacilityId` VARCHAR(191) NULL,
  `source` VARCHAR(191) NOT NULL DEFAULT 'MOBILE_ENROLLMENT',
  `status` VARCHAR(191) NOT NULL DEFAULT 'OPEN',
  `mobileDecision` VARCHAR(191) NULL,
  `matchScore` INTEGER NULL,
  `matchReasons` JSON NULL,
  `topCandidate` JSON NULL,
  `candidateIds` JSON NULL,
  `payload` JSON NULL,
  `resolutionAction` VARCHAR(191) NULL,
  `resolutionNote` VARCHAR(191) NULL,
  `resolvedByUserId` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `createdByUserId` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `DuplicateCase_primaryChildId_idx` ON `DuplicateCase`(`primaryChildId`);
CREATE INDEX `DuplicateCase_duplicateChildId_idx` ON `DuplicateCase`(`duplicateChildId`);
CREATE INDEX `DuplicateCase_facilityId_idx` ON `DuplicateCase`(`facilityId`);
CREATE INDEX `DuplicateCase_matchingFacilityId_idx` ON `DuplicateCase`(`matchingFacilityId`);
CREATE INDEX `DuplicateCase_status_idx` ON `DuplicateCase`(`status`);
CREATE INDEX `DuplicateCase_source_idx` ON `DuplicateCase`(`source`);
CREATE INDEX `DuplicateCase_createdAt_idx` ON `DuplicateCase`(`createdAt`);
