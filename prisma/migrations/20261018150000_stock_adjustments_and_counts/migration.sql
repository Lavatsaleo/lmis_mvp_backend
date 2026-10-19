-- Stock holds (quarantine), write-off requests with approval, physical stock
-- counts. Additive: no existing data changes.

-- AlterTable
ALTER TABLE `Box` ADD COLUMN `heldAt` DATETIME(3) NULL,
    ADD COLUMN `heldById` VARCHAR(191) NULL,
    ADD COLUMN `holdAdjustmentId` VARCHAR(191) NULL,
    ADD COLUMN `holdReason` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `StockAdjustment` (
    `id` VARCHAR(191) NOT NULL,
    `adjustmentNumber` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `reason` ENUM('EXPIRED', 'DAMAGED', 'LOST', 'THEFT', 'CONTAMINATED', 'RECALLED', 'COUNT_VARIANCE', 'OTHER') NOT NULL,
    `note` TEXT NULL,
    `status` ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_APPROVAL',
    `requestedById` VARCHAR(191) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `stockCountId` VARCHAR(191) NULL,
    `clientRequestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StockAdjustment_adjustmentNumber_key`(`adjustmentNumber`),
    UNIQUE INDEX `StockAdjustment_stockCountId_key`(`stockCountId`),
    UNIQUE INDEX `StockAdjustment_clientRequestId_key`(`clientRequestId`),
    INDEX `StockAdjustment_warehouseId_status_idx`(`warehouseId`, `status`),
    INDEX `StockAdjustment_implementationId_status_idx`(`implementationId`, `status`),
    INDEX `StockAdjustment_decidedAt_idx`(`decidedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockAdjustmentLine` (
    `id` VARCHAR(191) NOT NULL,
    `adjustmentId` VARCHAR(191) NOT NULL,
    `boxId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATETIME(3) NOT NULL,
    `donorId` VARCHAR(191) NULL,
    `unitsBefore` INTEGER NOT NULL,
    `unitsWrittenOff` INTEGER NOT NULL,
    `fullBox` BOOLEAN NOT NULL,
    `unitValue` DECIMAL(18, 6) NULL,
    `currencyCode` VARCHAR(191) NULL,

    INDEX `StockAdjustmentLine_adjustmentId_idx`(`adjustmentId`),
    INDEX `StockAdjustmentLine_boxId_idx`(`boxId`),
    INDEX `StockAdjustmentLine_productId_idx`(`productId`),
    INDEX `StockAdjustmentLine_donorId_idx`(`donorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockAdjustmentDocument` (
    `id` VARCHAR(191) NOT NULL,
    `adjustmentId` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,
    `uploadedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StockAdjustmentDocument_adjustmentId_idx`(`adjustmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockCount` (
    `id` VARCHAR(191) NOT NULL,
    `countNumber` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NULL,
    `status` ENUM('IN_PROGRESS', 'SUBMITTED', 'CANCELLED') NOT NULL DEFAULT 'IN_PROGRESS',
    `note` TEXT NULL,
    `startedById` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `submittedById` VARCHAR(191) NULL,
    `submittedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StockCount_countNumber_key`(`countNumber`),
    INDEX `StockCount_warehouseId_status_idx`(`warehouseId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StockCountLine` (
    `id` VARCHAR(191) NOT NULL,
    `stockCountId` VARCHAR(191) NOT NULL,
    `groupKey` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATETIME(3) NOT NULL,
    `donorId` VARCHAR(191) NULL,
    `expectedBoxes` INTEGER NOT NULL,
    `countedBoxes` INTEGER NULL,
    `addedByCounter` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(191) NULL,
    `countedAt` DATETIME(3) NULL,

    INDEX `StockCountLine_stockCountId_idx`(`stockCountId`),
    UNIQUE INDEX `StockCountLine_stockCountId_groupKey_key`(`stockCountId`, `groupKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Box_heldAt_idx` ON `Box`(`heldAt`);

-- CreateIndex
CREATE INDEX `Box_holdAdjustmentId_idx` ON `Box`(`holdAdjustmentId`);

-- AddForeignKey
ALTER TABLE `StockAdjustment` ADD CONSTRAINT `StockAdjustment_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Facility`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustment` ADD CONSTRAINT `StockAdjustment_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustment` ADD CONSTRAINT `StockAdjustment_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustment` ADD CONSTRAINT `StockAdjustment_stockCountId_fkey` FOREIGN KEY (`stockCountId`) REFERENCES `StockCount`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustmentLine` ADD CONSTRAINT `StockAdjustmentLine_adjustmentId_fkey` FOREIGN KEY (`adjustmentId`) REFERENCES `StockAdjustment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustmentLine` ADD CONSTRAINT `StockAdjustmentLine_boxId_fkey` FOREIGN KEY (`boxId`) REFERENCES `Box`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustmentDocument` ADD CONSTRAINT `StockAdjustmentDocument_adjustmentId_fkey` FOREIGN KEY (`adjustmentId`) REFERENCES `StockAdjustment`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockAdjustmentDocument` ADD CONSTRAINT `StockAdjustmentDocument_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockCount` ADD CONSTRAINT `StockCount_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Facility`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockCount` ADD CONSTRAINT `StockCount_startedById_fkey` FOREIGN KEY (`startedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockCount` ADD CONSTRAINT `StockCount_submittedById_fkey` FOREIGN KEY (`submittedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockCountLine` ADD CONSTRAINT `StockCountLine_stockCountId_fkey` FOREIGN KEY (`stockCountId`) REFERENCES `StockCount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_holdAdjustmentId_fkey` FOREIGN KEY (`holdAdjustmentId`) REFERENCES `StockAdjustment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

