-- Preload South Sudan's counties (10 states + 3 administrative areas) so the
-- admin only picks from a list. Counties group field bases and sites; when a
-- county is chosen, only that county's field bases are offered.
--
-- Spelling follows ACF's own site list where it differs from the official one
-- (e.g. "Aweil Center"). Only inserted for the South Sudan implementation and
-- only when missing, so it is safe to re-run and leaves Kenya untouched.

INSERT INTO `County` (`id`, `implementationId`, `name`, `state`, `isActive`, `createdAt`, `updatedAt`)
SELECT
  CONCAT('cty_ss_', LOWER(REPLACE(REPLACE(REPLACE(c.`name`, ' ', '_'), '/', '_'), '-', '_'))),
  i.`id`, c.`name`, c.`state`, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Implementation` i
JOIN `Country` co ON co.`id` = i.`countryId` AND co.`code` = 'SS'
JOIN (
  -- Central Equatoria
  SELECT 'Juba' AS `name`, 'Central Equatoria' AS `state`
  UNION ALL SELECT 'Kajo-Keji', 'Central Equatoria'
  UNION ALL SELECT 'Lainya', 'Central Equatoria'
  UNION ALL SELECT 'Morobo', 'Central Equatoria'
  UNION ALL SELECT 'Terekeka', 'Central Equatoria'
  UNION ALL SELECT 'Yei', 'Central Equatoria'
  -- Eastern Equatoria
  UNION ALL SELECT 'Budi', 'Eastern Equatoria'
  UNION ALL SELECT 'Ikotos', 'Eastern Equatoria'
  UNION ALL SELECT 'Kapoeta East', 'Eastern Equatoria'
  UNION ALL SELECT 'Kapoeta North', 'Eastern Equatoria'
  UNION ALL SELECT 'Kapoeta South', 'Eastern Equatoria'
  UNION ALL SELECT 'Lafon', 'Eastern Equatoria'
  UNION ALL SELECT 'Magwi', 'Eastern Equatoria'
  UNION ALL SELECT 'Torit', 'Eastern Equatoria'
  -- Western Equatoria
  UNION ALL SELECT 'Ezo', 'Western Equatoria'
  UNION ALL SELECT 'Ibba', 'Western Equatoria'
  UNION ALL SELECT 'Maridi', 'Western Equatoria'
  UNION ALL SELECT 'Mundri East', 'Western Equatoria'
  UNION ALL SELECT 'Mundri West', 'Western Equatoria'
  UNION ALL SELECT 'Mvolo', 'Western Equatoria'
  UNION ALL SELECT 'Nagero', 'Western Equatoria'
  UNION ALL SELECT 'Nzara', 'Western Equatoria'
  UNION ALL SELECT 'Tambura', 'Western Equatoria'
  UNION ALL SELECT 'Yambio', 'Western Equatoria'
  -- Jonglei
  UNION ALL SELECT 'Akobo', 'Jonglei'
  UNION ALL SELECT 'Ayod', 'Jonglei'
  UNION ALL SELECT 'Bor South', 'Jonglei'
  UNION ALL SELECT 'Canal/Pigi', 'Jonglei'
  UNION ALL SELECT 'Duk', 'Jonglei'
  UNION ALL SELECT 'Fangak', 'Jonglei'
  UNION ALL SELECT 'Nyirol', 'Jonglei'
  UNION ALL SELECT 'Twic East', 'Jonglei'
  UNION ALL SELECT 'Uror', 'Jonglei'
  -- Greater Pibor Administrative Area
  UNION ALL SELECT 'Pibor', 'Greater Pibor Administrative Area'
  UNION ALL SELECT 'Pochalla', 'Greater Pibor Administrative Area'
  -- Upper Nile
  UNION ALL SELECT 'Akoka', 'Upper Nile'
  UNION ALL SELECT 'Baliet', 'Upper Nile'
  UNION ALL SELECT 'Fashoda', 'Upper Nile'
  UNION ALL SELECT 'Longochuk', 'Upper Nile'
  UNION ALL SELECT 'Luakpiny/Nasir', 'Upper Nile'
  UNION ALL SELECT 'Maban', 'Upper Nile'
  UNION ALL SELECT 'Maiwut', 'Upper Nile'
  UNION ALL SELECT 'Malakal', 'Upper Nile'
  UNION ALL SELECT 'Manyo', 'Upper Nile'
  UNION ALL SELECT 'Melut', 'Upper Nile'
  UNION ALL SELECT 'Panyikang', 'Upper Nile'
  UNION ALL SELECT 'Renk', 'Upper Nile'
  UNION ALL SELECT 'Ulang', 'Upper Nile'
  -- Unity
  UNION ALL SELECT 'Guit', 'Unity'
  UNION ALL SELECT 'Koch', 'Unity'
  UNION ALL SELECT 'Leer', 'Unity'
  UNION ALL SELECT 'Mayendit', 'Unity'
  UNION ALL SELECT 'Mayom', 'Unity'
  UNION ALL SELECT 'Panyijiar', 'Unity'
  UNION ALL SELECT 'Rubkona', 'Unity'
  -- Ruweng Administrative Area
  UNION ALL SELECT 'Abiemnhom', 'Ruweng Administrative Area'
  UNION ALL SELECT 'Pariang', 'Ruweng Administrative Area'
  -- Warrap
  UNION ALL SELECT 'Gogrial East', 'Warrap'
  UNION ALL SELECT 'Gogrial West', 'Warrap'
  UNION ALL SELECT 'Tonj East', 'Warrap'
  UNION ALL SELECT 'Tonj North', 'Warrap'
  UNION ALL SELECT 'Tonj South', 'Warrap'
  UNION ALL SELECT 'Twic', 'Warrap'
  -- Northern Bahr el Ghazal
  UNION ALL SELECT 'Aweil Center', 'Northern Bahr el Ghazal'
  UNION ALL SELECT 'Aweil East', 'Northern Bahr el Ghazal'
  UNION ALL SELECT 'Aweil North', 'Northern Bahr el Ghazal'
  UNION ALL SELECT 'Aweil South', 'Northern Bahr el Ghazal'
  UNION ALL SELECT 'Aweil West', 'Northern Bahr el Ghazal'
  -- Western Bahr el Ghazal
  UNION ALL SELECT 'Jur River', 'Western Bahr el Ghazal'
  UNION ALL SELECT 'Raja', 'Western Bahr el Ghazal'
  UNION ALL SELECT 'Wau', 'Western Bahr el Ghazal'
  -- Lakes
  UNION ALL SELECT 'Awerial', 'Lakes'
  UNION ALL SELECT 'Cueibet', 'Lakes'
  UNION ALL SELECT 'Rumbek Centre', 'Lakes'
  UNION ALL SELECT 'Rumbek East', 'Lakes'
  UNION ALL SELECT 'Rumbek North', 'Lakes'
  UNION ALL SELECT 'Wulu', 'Lakes'
  UNION ALL SELECT 'Yirol East', 'Lakes'
  UNION ALL SELECT 'Yirol West', 'Lakes'
  -- Abyei Administrative Area
  UNION ALL SELECT 'Abyei', 'Abyei Administrative Area'
) c
WHERE i.`code` = 'LOGISTICS'
  AND NOT EXISTS (
    SELECT 1 FROM `County` x WHERE x.`implementationId` = i.`id` AND x.`name` = c.`name`
  );
