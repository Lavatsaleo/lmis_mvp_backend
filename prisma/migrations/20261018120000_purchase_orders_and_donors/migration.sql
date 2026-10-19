-- Purchase orders, donors and goods receipts. Additive: existing orders and
-- boxes keep working; boxes get a donor from their order's donor name.

-- AlterTable
ALTER TABLE `Box` ADD COLUMN `donorId` VARCHAR(191) NULL,
    ADD COLUMN `goodsReceiptId` VARCHAR(191) NULL,
    ADD COLUMN `purchaseOrderLineId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Order` ADD COLUMN `purchaseOrderId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Donor` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Donor_implementationId_idx`(`implementationId`),
    UNIQUE INDEX `Donor_implementationId_name_key`(`implementationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PurchaseOrder` (
    `id` VARCHAR(191) NOT NULL,
    `implementationId` VARCHAR(191) NOT NULL,
    `poNumber` VARCHAR(191) NOT NULL,
    `supplierName` VARCHAR(191) NULL,
    `destinationWarehouseId` VARCHAR(191) NOT NULL,
    `orderDate` DATETIME(3) NULL,
    `expectedDeliveryDate` DATETIME(3) NULL,
    `currencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD',
    `status` ENUM('OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `note` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PurchaseOrder_destinationWarehouseId_idx`(`destinationWarehouseId`),
    INDEX `PurchaseOrder_status_idx`(`status`),
    INDEX `PurchaseOrder_expectedDeliveryDate_idx`(`expectedDeliveryDate`),
    UNIQUE INDEX `PurchaseOrder_implementationId_poNumber_key`(`implementationId`, `poNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PurchaseOrderLine` (
    `id` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `lineNo` INTEGER NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `donorId` VARCHAR(191) NOT NULL,
    `grantCode` VARCHAR(191) NULL,
    `quantityPacks` INTEGER NOT NULL,
    `unitPrice` DECIMAL(18, 6) NOT NULL,
    `receivedPacks` INTEGER NOT NULL DEFAULT 0,

    INDEX `PurchaseOrderLine_productId_idx`(`productId`),
    INDEX `PurchaseOrderLine_donorId_idx`(`donorId`),
    UNIQUE INDEX `PurchaseOrderLine_purchaseOrderId_lineNo_key`(`purchaseOrderId`, `lineNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PurchaseOrderDocument` (
    `id` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `data` LONGBLOB NOT NULL,
    `uploadedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PurchaseOrderDocument_purchaseOrderId_idx`(`purchaseOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoodsReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `grnNumber` VARCHAR(191) NOT NULL,
    `purchaseOrderId` VARCHAR(191) NOT NULL,
    `warehouseId` VARCHAR(191) NOT NULL,
    `receivedById` VARCHAR(191) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveryNote` VARCHAR(191) NULL,
    `waybillNo` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `clientRequestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `GoodsReceipt_grnNumber_key`(`grnNumber`),
    UNIQUE INDEX `GoodsReceipt_clientRequestId_key`(`clientRequestId`),
    INDEX `GoodsReceipt_purchaseOrderId_idx`(`purchaseOrderId`),
    INDEX `GoodsReceipt_warehouseId_receivedAt_idx`(`warehouseId`, `receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GoodsReceiptLine` (
    `id` VARCHAR(191) NOT NULL,
    `goodsReceiptId` VARCHAR(191) NOT NULL,
    `purchaseOrderLineId` VARCHAR(191) NOT NULL,
    `batchNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATETIME(3) NOT NULL,
    `packs` INTEGER NOT NULL,

    INDEX `GoodsReceiptLine_goodsReceiptId_idx`(`goodsReceiptId`),
    INDEX `GoodsReceiptLine_purchaseOrderLineId_idx`(`purchaseOrderLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Box_donorId_idx` ON `Box`(`donorId`);

-- CreateIndex
CREATE INDEX `Box_purchaseOrderLineId_idx` ON `Box`(`purchaseOrderLineId`);

-- CreateIndex
CREATE INDEX `Box_goodsReceiptId_idx` ON `Box`(`goodsReceiptId`);

-- CreateIndex
CREATE UNIQUE INDEX `Order_purchaseOrderId_key` ON `Order`(`purchaseOrderId`);

-- AddForeignKey
ALTER TABLE `Donor` ADD CONSTRAINT `Donor_implementationId_fkey` FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrder` ADD CONSTRAINT `PurchaseOrder_implementationId_fkey` FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrder` ADD CONSTRAINT `PurchaseOrder_destinationWarehouseId_fkey` FOREIGN KEY (`destinationWarehouseId`) REFERENCES `Facility`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrder` ADD CONSTRAINT `PurchaseOrder_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderLine` ADD CONSTRAINT `PurchaseOrderLine_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderLine` ADD CONSTRAINT `PurchaseOrderLine_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderLine` ADD CONSTRAINT `PurchaseOrderLine_donorId_fkey` FOREIGN KEY (`donorId`) REFERENCES `Donor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderDocument` ADD CONSTRAINT `PurchaseOrderDocument_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseOrderDocument` ADD CONSTRAINT `PurchaseOrderDocument_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceipt` ADD CONSTRAINT `GoodsReceipt_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceipt` ADD CONSTRAINT `GoodsReceipt_warehouseId_fkey` FOREIGN KEY (`warehouseId`) REFERENCES `Facility`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceipt` ADD CONSTRAINT `GoodsReceipt_receivedById_fkey` FOREIGN KEY (`receivedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptLine` ADD CONSTRAINT `GoodsReceiptLine_goodsReceiptId_fkey` FOREIGN KEY (`goodsReceiptId`) REFERENCES `GoodsReceipt`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `GoodsReceiptLine` ADD CONSTRAINT `GoodsReceiptLine_purchaseOrderLineId_fkey` FOREIGN KEY (`purchaseOrderLineId`) REFERENCES `PurchaseOrderLine`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `PurchaseOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_donorId_fkey` FOREIGN KEY (`donorId`) REFERENCES `Donor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_purchaseOrderLineId_fkey` FOREIGN KEY (`purchaseOrderLineId`) REFERENCES `PurchaseOrderLine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Box` ADD CONSTRAINT `Box_goodsReceiptId_fkey` FOREIGN KEY (`goodsReceiptId`) REFERENCES `GoodsReceipt`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: one Donor per distinct donor name already used on orders, per
-- implementation (case-insensitive, like the unique index), then link boxes.
INSERT INTO `Donor` (`id`, `implementationId`, `name`, `isActive`, `createdAt`, `updatedAt`)
SELECT UUID(), x.implementationId, x.name, true, NOW(3), NOW(3)
FROM (
  SELECT DISTINCT p.implementationId, TRIM(o.donorName) AS name
  FROM `Box` b
  JOIN `Order` o ON o.id = b.orderId
  JOIN `Product` p ON p.id = b.productId
  WHERE o.donorName IS NOT NULL AND TRIM(o.donorName) <> '' AND p.implementationId IS NOT NULL
) x;

UPDATE `Box` b
JOIN `Order` o ON o.id = b.orderId
JOIN `Product` p ON p.id = b.productId
JOIN `Donor` d ON d.implementationId = p.implementationId AND d.name = TRIM(o.donorName)
SET b.donorId = d.id
WHERE b.donorId IS NULL;
