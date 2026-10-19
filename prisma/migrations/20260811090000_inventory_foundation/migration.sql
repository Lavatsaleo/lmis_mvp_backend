-- Phase 2A-2C: generic stock locations, configurable product logistics/valuation,
-- and the reporting foundation for stock quantity, metric tonnes and monetary value.
--
-- This migration is additive. It deliberately keeps Facility, Box, Shipment and
-- the current Kenya clinical/dispensing structures intact.

-- Implementation reporting currency (South Sudan will use USD; Kenya defaults to USD).
ALTER TABLE `Implementation`
  ADD COLUMN `reportingCurrencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD';

-- Generic stock-location metadata on the existing Facility table. This lets us
-- evolve Kenya safely while supporting Central Warehouse -> Field Base -> Clinic.
ALTER TABLE `Facility`
  ADD COLUMN `stockLocationType` ENUM('CENTRAL_WAREHOUSE','FIELD_BASE_WAREHOUSE','CLINIC_STORE','PHARMACY_STORE','OTHER') NOT NULL DEFAULT 'CLINIC_STORE',
  ADD COLUMN `parentStockLocationId` VARCHAR(191) NULL,
  ADD COLUMN `capacityMetricTonnes` DECIMAL(12,3) NULL;

CREATE INDEX `Facility_parentStockLocationId_idx` ON `Facility`(`parentStockLocationId`);
CREATE INDEX `Facility_stockLocationType_idx` ON `Facility`(`stockLocationType`);

-- Preserve current Kenya semantics. Existing WAREHOUSE records become central
-- warehouses; existing facilities become clinic stores and inherit their legacy
-- warehouse as the generic parent stock location.
UPDATE `Facility`
SET `stockLocationType` = CASE
  WHEN `type` = 'WAREHOUSE' THEN 'CENTRAL_WAREHOUSE'
  ELSE 'CLINIC_STORE'
END;

UPDATE `Facility`
SET `parentStockLocationId` = `warehouseId`
WHERE `warehouseId` IS NOT NULL AND `parentStockLocationId` IS NULL;

-- Configurable product packaging, logistics weight and default valuation.
-- Defaults intentionally reproduce the current Kenya model: 600 sachets / box.
ALTER TABLE `Product`
  ADD COLUMN `baseUnitName` VARCHAR(191) NOT NULL DEFAULT 'Sachet',
  ADD COLUMN `packUnitName` VARCHAR(191) NOT NULL DEFAULT 'Box',
  ADD COLUMN `unitsPerPack` INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN `grossPackWeightKg` DECIMAL(12,4) NULL,
  ADD COLUMN `defaultUnitValue` DECIMAL(18,6) NULL,
  ADD COLUMN `defaultCurrencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD',
  ADD COLUMN `trackBatch` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `trackExpiry` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX `Product_isActive_idx` ON `Product`(`isActive`);

-- Batch-specific valuation. unitValue is always per base unit, which lets the
-- inventory reports value partial packs accurately after dispensing.
CREATE TABLE `ProductBatchValuation` (
  `id` VARCHAR(191) NOT NULL,
  `implementationId` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `batchNo` VARCHAR(191) NOT NULL,
  `unitValue` DECIMAL(18,6) NOT NULL,
  `currencyCode` VARCHAR(191) NOT NULL DEFAULT 'USD',
  `valuationBasis` ENUM('PURCHASE_COST','DONOR_DECLARED_VALUE','REPLACEMENT_COST','ESTIMATED_VALUE') NOT NULL DEFAULT 'PURCHASE_COST',
  `sourceType` ENUM('PURCHASE','IN_KIND_DONATION','TRANSFER','RETURN','OPENING_BALANCE','OTHER') NOT NULL DEFAULT 'PURCHASE',
  `sourceReference` VARCHAR(191) NULL,
  `note` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ProductBatchValuation_productId_batchNo_key`(`productId`, `batchNo`),
  INDEX `ProductBatchValuation_implementationId_idx`(`implementationId`),
  INDEX `ProductBatchValuation_productId_idx`(`productId`),
  INDEX `ProductBatchValuation_batchNo_idx`(`batchNo`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Facility`
  ADD CONSTRAINT `Facility_parentStockLocationId_fkey`
  FOREIGN KEY (`parentStockLocationId`) REFERENCES `Facility`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `ProductBatchValuation`
  ADD CONSTRAINT `ProductBatchValuation_implementationId_fkey`
  FOREIGN KEY (`implementationId`) REFERENCES `Implementation`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ProductBatchValuation`
  ADD CONSTRAINT `ProductBatchValuation_productId_fkey`
  FOREIGN KEY (`productId`) REFERENCES `Product`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
