-- Look up "IsOnWhatsapp" rows by whole jidOptions entries (see #32).
--
-- Lookups used to match jidOptions with LIKE '%jid%', which no index serves (every pattern ends in a domain nearly
-- every row contains) and which also matched numbers that merely end with the searched one. onWhatsappCache.ts now
-- asks `string_to_array("jidOptions", ',') && $1::text[]`; this GIN index serves exactly that expression. A query
-- must spell the expression the same way, or the planner won't use the index.
--
-- Depends on 20261111120000_is_on_whatsapp_fix_doubled_domain: exact matching only finds entries spelled like the JIDs
-- searched for. Prisma can't express an expression index, so it lives only in SQL; see the note on model IsOnWhatsapp.
CREATE INDEX "IsOnWhatsapp_jidOptions_elements_idx"
  ON "IsOnWhatsapp" USING gin (string_to_array("jidOptions", ','));
