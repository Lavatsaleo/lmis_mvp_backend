-- Phase 1: multi-country / multi-implementation foundation.
-- This migration is intentionally additive. Existing Kenya records are preserved
-- and linked to the first implementation: Kenya -> SQLNS Programme.

-- CreateTable
CREATE TABLE `Country` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Country_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Implementation` (
    `id` VARCHAR(191) NOT NULL,
    `countryId` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Implementation_countryId_idx`(`countryId`),
    INDEX `Implementation_isActive_idx`(`isActive`),
    UNIQUE INDEX `Implementation_countryId_code_key`(`countryId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ImplementationModule` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `module` ENUM('LOGISTICS', 'PHARMACY', 'CLINICAL') NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ImplementationModule_implementationId_idx`(`implementationId`),
    INDEX `ImplementationModule_module_isEnabled_idx`(`module`, `isEnabled`),
    UNIQUE INDEX `ImplementationModule_implementationId_module_key`(`implementationId`, `module`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: keep these links nullable for a safe additive rollout.
ALTER TABLE `Facility` ADD COLUMN `implementationId` VARCHAR(191) NULL;
ALTER TABLE `User` ADD COLUMN `implementationId` VARCHAR(191) NULL;
ALTER TABLE `Product` ADD COLUMN `implementationId` VARCHAR(191) NULL;

CREATE INDEX `Facility_implementationId_idx` ON `Facility`(`implementationId`);
CREATE INDEX `User_implementationId_idx` ON `User`(`implementationId`);
CREATE INDEX `Product_implementationId_idx` ON `Product`(`implementationId`);

-- Seed the current production context. Static IDs make the backfill deterministic.
INSERT INTO `Country` (`id`, `code`, `name`, `isActive`, `createdAt`, `updatedAt`)
VALUES ('country_kenya', 'KE', 'Kenya', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `Implementation` (`id`, `countryId`, `code`, `name`, `isActive`, `createdAt`, `updatedAt`)
VALUES ('impl_kenya_sqlns', 'country_kenya', 'SQLNS', 'SQLNS Programme', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

INSERT INTO `ImplementationModule` (`id`, `implementationId`, `module`, `isEnabled`, `createdAt`, `updatedAt`) VALUES
('implmod_kenya_sqlns_logistics', 'impl_kenya_sqlns', 'LOGISTICS', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
('implmod_kenya_sqlns_pharmacy',  'impl_kenya_sqlns', 'PHARMACY',  true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
('implmod_kenya_sqlns_clinical',  'impl_kenya_sqlns', 'CLINICAL',  true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- Backfill every current record into the Kenya SQLNS implementation.
UPDATE `Facility` SET `implementationId` = 'impl_kenya_sqlns' WHERE `implementationId` IS NULL;
UPDATE `User` SET `implementationId` = 'impl_kenya_sqlns' WHERE `implementationId` IS NULL;
UPDATE `Product` SET `implementationId` = 'impl_kenya_sqlns' WHERE `implementationId` IS NULL;

-- AddForeignKey
ALTER TABLE `Implementation` ADD CONSTRAINT `Implementation_countryId_fkey`
FOREIGN KEY (`countryId`) REFERENCES `Country`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ImplementationModule` ADD CONSTRAINT `ImplementationModule_implementationId_fkey`
FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Facility` ADD CONSTRAINT `Facility_implementationId_fkey`
FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `User` ADD CONSTRAINT `User_implementationId_fkey`
FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `Product` ADD CONSTRAINT `Product_implementationId_fkey`
FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
