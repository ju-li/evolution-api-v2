-- Store each "IsOnWhatsapp".jidOptions entry with its domain once (see #30).
--
-- getAvailableNumbers() appended the domain twice for numbers outside Brazil, Mexico and Argentina, so most rows hold
-- '14155550123@s.whatsapp.net@s.whatsapp.net'. The code now writes and searches for '14155550123@s.whatsapp.net';
-- this rewrites the stored entries to match, so they stay findable once lookups compare whole entries (see #32).
--
-- Each entry of the form 'number@domain@domain' becomes 'number@domain'. The list is then deduplicated (a row can hold
-- both spellings) and sorted bytewise, which is how saveOnWhatsappCache() writes it. "updatedAt" is left alone: the
-- cache data itself is no fresher than before.
UPDATE "IsOnWhatsapp"
SET "jidOptions" = (
  SELECT string_agg(DISTINCT fixed.j, ',' ORDER BY fixed.j)
  FROM (
    SELECT regexp_replace(j, '^([^@]*)@([^@]+)@\2$', '\1@\2') COLLATE "C" AS j
    FROM unnest(string_to_array("jidOptions", ',')) AS entries(j)
  ) fixed
)
WHERE "jidOptions" ~ '@[^,@]*@';
