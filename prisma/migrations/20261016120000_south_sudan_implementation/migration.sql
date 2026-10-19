-- South Sudan country and implementation.
--
-- South Sudan uses LMIS for logistics only: clinical tracking stays in DHIS2
-- (dispenses arrive from DHIS2; stock levels are sent back). So LOGISTICS is
-- enabled and CLINICAL / PHARMACY rows exist but are disabled, which keeps the
-- Kenya clinical screens and endpoints out of South Sudan users' way.
--
-- Written to be safe if a South Sudan record was already created by hand: rows
-- are only inserted when missing, and looked up by their natural keys.

INSERT INTO `Country` (`id`, `code`, `name`, `isActive`, `createdAt`, `updatedAt`)
SELECT 'country_south_sudan', 'SS', 'South Sudan', true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `Country` WHERE `code` = 'SS');

INSERT INTO `Implementation`
  (`id`, `countryId`, `code`, `name`, `isActive`, `reportingCurrencyCode`, `createdAt`, `updatedAt`)
SELECT 'impl_south_sudan_logistics', c.`id`, 'LOGISTICS', 'South Sudan Logistics', true, 'USD',
       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Country` c
WHERE c.`code` = 'SS'
  AND NOT EXISTS (
    SELECT 1 FROM `Implementation` i WHERE i.`countryId` = c.`id` AND i.`code` = 'LOGISTICS'
  );

INSERT INTO `ImplementationModule` (`id`, `implementationId`, `module`, `isEnabled`, `createdAt`, `updatedAt`)
SELECT CONCAT('implmod_ss_', LOWER(m.`module`)), i.`id`, m.`module`, m.`isEnabled`,
       CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Implementation` i
JOIN `Country` c ON c.`id` = i.`countryId` AND c.`code` = 'SS'
JOIN (
  SELECT 'LOGISTICS' AS `module`, true AS `isEnabled`
  UNION ALL SELECT 'PHARMACY', false
  UNION ALL SELECT 'CLINICAL', false
) m
WHERE i.`code` = 'LOGISTICS'
  AND NOT EXISTS (
    SELECT 1 FROM `ImplementationModule` x WHERE x.`implementationId` = i.`id` AND x.`module` = m.`module`
  );
