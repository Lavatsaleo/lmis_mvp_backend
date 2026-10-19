-- Mobile stock-control tools per implementation (off by default: Kenya keeps
-- its current app). South Sudan already uses them.
ALTER TABLE `Implementation` ADD COLUMN `warehouseTools` BOOLEAN NOT NULL DEFAULT false;

UPDATE `Implementation` i
JOIN `Country` c ON c.id = i.countryId
SET i.warehouseTools = true
WHERE c.code = 'SS';
