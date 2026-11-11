-- Repair "IsOnWhatsapp"."jidOptions" entries with a doubled domain (see #30).
--
-- getAvailableNumbers() appended the domain to a full JID for every number outside Brazil, Mexico and Argentina,
-- so most rows store '<number>@s.whatsapp.net@s.whatsapp.net'. The cache lookups compare entries exactly against
-- '<number>@s.whatsapp.net', so those rows never hit. The code is fixed; this rewrites the existing rows once.
--
-- A row can hold both forms (fixed code writing the correct entry next to the doubled one), so the list is
-- deduplicated. It stays sorted like saveOnWhatsappCache writes it (COLLATE "C" matches JavaScript's sort for JIDs).
UPDATE "IsOnWhatsapp"
SET "jidOptions" = (
  SELECT string_agg(
    DISTINCT replace(j, '@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net') COLLATE "C",
    ','
    ORDER BY replace(j, '@s.whatsapp.net@s.whatsapp.net', '@s.whatsapp.net') COLLATE "C"
  )
  FROM unnest(string_to_array("jidOptions", ',')) AS j
)
WHERE "jidOptions" LIKE '%@s.whatsapp.net@s.whatsapp.net%';
