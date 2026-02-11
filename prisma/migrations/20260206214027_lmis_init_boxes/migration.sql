-- AlterTable
ALTER TABLE `facility` ADD COLUMN `type` ENUM('WAREHOUSE', 'FACILITY') NOT NULL DEFAULT 'FACILITY';

-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(191) NOT NULL,
    `orderNumber` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Order_orderNumber_key`(`orderNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `Product_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Box` (
    `id` VARCHAR(191) NOT NULL,
    `boxUid` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATETIME(3) NOT NULL,
    `status` ENUM('CREATED', 'IN_WAREHOUSE', 'IN_TRANSIT', 'IN_FACILITY', 'DISPENSED', 'VOID') NOT NULL DEFAULT 'CREATED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `currentFacilityId` VARCHAR(191) NULL,

    UNIQUE INDEX `Box_boxUid_key`(`boxUid`),
    INDEX `Box_orderId_idx`(`orderId`),
    INDEX `Box_productId_idx`(`productId`),
    INDEX `Box_currentFacilityId_idx`(`currentFacilityId`),
    INDEX `Box_batchNo_idx`(`batchNo`),
    INDEX `Box_expiryDate_idx`(`expiryDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BoxEvent` (
    `id` VARCHAR(191) NOT NULL,
    `boxId` VARCHAR(191) NOT NULL,
    `type` ENUM('QR_CREATED', 'WAREHOUSE_RECEIVE', 'DISPATCH', 'FACILITY_RECEIVE', 'DISPENSE', 'ADJUSTMENT') NOT NULL,
    `performedByUserId` VARCHAR(191) NOT NULL,
    `fromFacilityId` VARCHAR(191) NULL,
    `toFacilityId` VARCHAR(191) NULL,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BoxEvent_boxId_idx`(`boxId`),
    INDEX `BoxEvent_performedByUserId_idx`(`performedByUserId`),
    INDEX `BoxEvent_fromFacilityId_idx`(`fromFacilityId`),
    INDEX `BoxEvent_toFacilityId_idx`(`toFacilityId`),
    INDEX `BoxEvent_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_currentFacilityId_fkey` FOREIGN KEY (`currentFacilityId`) REFERENCES `Facility`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEvent` ADD CONSTRAINT `BoxEvent_boxId_fkey` FOREIGN KEY (`boxId`) REFERENCES `Box`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEvent` ADD CONSTRAINT `BoxEvent_performedByUserId_fkey` FOREIGN KEY (`performedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEvent` ADD CONSTRAINT `BoxEvent_fromFacilityId_fkey` FOREIGN KEY (`fromFacilityId`) REFERENCES `Facility`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BoxEvent` ADD CONSTRAINT `BoxEvent_toFacilityId_fkey` FOREIGN KEY (`toFacilityId`) REFERENCES `Facility`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
