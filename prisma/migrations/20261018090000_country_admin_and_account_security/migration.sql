-- Country admin role, sign-in lockout, forced password change, audit log.
-- Additive only: existing users keep their role and can sign in as before.

ALTER TABLE `User`
  MODIFY `role` ENUM('SUPER_ADMIN', 'COUNTRY_ADMIN', 'WAREHOUSE_OFFICER', 'FACILITY_OFFICER', 'CLINICIAN', 'VIEWER') NOT NULL DEFAULT 'VIEWER',
  ADD COLUMN `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `lockedUntil` DATETIME(3) NULL,
  ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `passwordChangedAt` DATETIME(3) NULL;

CREATE TABLE `AuditLog` (
  `id` VARCHAR(191) NOT NULL,
  `action` VARCHAR(191) NOT NULL,
  `actorId` VARCHAR(191) NULL,
  `actorEmail` VARCHAR(191) NULL,
  `targetType` VARCHAR(191) NULL,
  `targetId` VARCHAR(191) NULL,
  `targetLabel` VARCHAR(191) NULL,
  `implementationId` VARCHAR(191) NULL,
  `details` JSON NULL,
  `ipAddress` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `AuditLog_createdAt_idx`(`createdAt`),
  INDEX `AuditLog_actorId_idx`(`actorId`),
  INDEX `AuditLog_targetType_targetId_idx`(`targetType`, `targetId`),
  INDEX `AuditLog_implementationId_createdAt_idx`(`implementationId`, `createdAt`),
  INDEX `AuditLog_action_idx`(`action`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AuditLog` ADD CONSTRAINT `AuditLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
