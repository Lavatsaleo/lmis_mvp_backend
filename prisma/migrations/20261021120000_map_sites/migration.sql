-- Programme site locations for the map (from the country's GPS list).
CREATE TABLE `MapSite` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NULL,
    `county` VARCHAR(191) NULL,
    `payam` VARCHAR(191) NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `issues` JSON NULL,
    `source` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MapSite_implementationId_name_key`(`implementationId`, `name`),
    INDEX `MapSite_implementationId_idx`(`implementationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `MapSite` ADD CONSTRAINT `MapSite_implementationId_fkey` FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
