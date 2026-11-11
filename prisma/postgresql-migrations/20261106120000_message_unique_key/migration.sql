-- One row per WhatsApp message (see #9).
--
-- "Message" had no unique key besides its cuid, so history-sync batches racing each other or racing live
-- messages.upsert stored the same message 2-3 times, and createMany({ skipDuplicates: true }) was inert.
-- This migration removes the duplicates and adds a unique index on the message key so the database enforces it.
--
-- On a large table the dedupe and the index build take minutes, and Evolution serves nothing until migrations finish.
-- So the index can be built ahead of time, while the old version keeps serving (see #33/#34):
--
--   -- dedupe first (steps 1-3 below), then:
--   CREATE UNIQUE INDEX CONCURRENTLY "Message_instanceId_key_unique"
--     ON "Message" ("instanceId", ("key"->>'remoteJid'), ("key"->>'id'), (("key"->>'fromMe')::boolean));
--
-- When a valid index with exactly that definition already exists, this migration does nothing: no lock, no deletes.
-- Otherwise it runs as one transaction. The lock blocks concurrent writers (e.g. an old container still running
-- during a rolling deploy) between the cleanup and the index build, so no new duplicate can sneak in; reads continue.
DO $$
DECLARE
  existing_valid boolean;
  existing_matches boolean;
  existing_def text;
BEGIN
  SELECT
    i.indisvalid,
    i.indisunique
      AND i.indpred IS NULL
      AND i.indnatts = 4
      AND am.amname = 'btree'
      AND pg_get_indexdef(i.indexrelid, 1, true) = '"instanceId"'
      AND pg_get_indexdef(i.indexrelid, 2, true) = '(key ->> ''remoteJid''::text)'
      AND pg_get_indexdef(i.indexrelid, 3, true) = '(key ->> ''id''::text)'
      AND pg_get_indexdef(i.indexrelid, 4, true) = '((key ->> ''fromMe''::text)::boolean)',
    pg_get_indexdef(i.indexrelid)
  INTO existing_valid, existing_matches, existing_def
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_am am ON am.oid = c.relam
  WHERE i.indrelid = '"Message"'::regclass
    AND c.relname = 'Message_instanceId_key_unique';

  IF existing_valid AND existing_matches THEN
    RAISE NOTICE 'Index "Message_instanceId_key_unique" already exists and is valid; skipping dedupe and index build.';
    RETURN;
  END IF;

  IF existing_valid THEN
    -- A valid index under our name but with another definition was built by hand. Don't silently drop it and start
    -- a full rebuild (minutes of downtime on a large table); make the operator look.
    RAISE EXCEPTION 'Index "Message_instanceId_key_unique" exists but does not match the expected definition: %',
      existing_def
      USING HINT = 'Drop it, or rebuild it with the definition at the top of this migration, then deploy again.';
  END IF;

  -- A failed CREATE INDEX CONCURRENTLY leaves an INVALID index behind, which enforces nothing. Start over.
  DROP INDEX IF EXISTS "Message_instanceId_key_unique";

  LOCK TABLE "Message" IN SHARE ROW EXCLUSIVE MODE;

  -- 1. For every duplicated key pick the row to keep:
  --    edited/deleted state first (it carries the latest content), then the most advanced delivery status,
  --    then a real push name (not a JID or bare number), then the oldest row.
  CREATE TEMP TABLE "_message_dedupe" AS
  SELECT "id", "keep_id"
  FROM (
    SELECT
      "id",
      first_value("id") OVER w AS "keep_id",
      row_number() OVER w AS "rn"
    FROM "Message"
    WHERE "key"->>'id' IS NOT NULL
    WINDOW w AS (
      PARTITION BY "instanceId", ("key"->>'remoteJid'), ("key"->>'id'), (("key"->>'fromMe')::boolean)
      ORDER BY
        ("status" IN ('EDITED', 'DELETED')) DESC NULLS LAST,
        CASE "status"
          WHEN 'PLAYED' THEN 5
          WHEN 'READ' THEN 4
          WHEN 'DELIVERY_ACK' THEN 3
          WHEN 'SERVER_ACK' THEN 2
          WHEN 'PENDING' THEN 1
          ELSE 0
        END DESC,
        ("pushName" IS NOT NULL AND "pushName" !~ '@' AND "pushName" !~ '^[0-9+ ]+$') DESC,
        "id" ASC
    )
  ) ranked
  WHERE "rn" > 1;

  -- 2. Keep the duplicates' history attached to the surviving row.
  UPDATE "MessageUpdate" mu
  SET "messageId" = d."keep_id"
  FROM "_message_dedupe" d
  WHERE mu."messageId" = d."id";

  -- Media.messageId is unique: move one duplicate's media only when the surviving row has none.
  UPDATE "Media" m
  SET "messageId" = moved."keep_id"
  FROM (
    SELECT DISTINCT ON (d."keep_id") md."id" AS "media_id", d."keep_id"
    FROM "Media" md
    JOIN "_message_dedupe" d ON md."messageId" = d."id"
    WHERE NOT EXISTS (SELECT 1 FROM "Media" keep WHERE keep."messageId" = d."keep_id")
    ORDER BY d."keep_id", md."createdAt" ASC NULLS LAST, md."id" ASC
  ) moved
  WHERE m."id" = moved."media_id";

  -- 3. Remove the duplicates (any media rows still attached to them cascade).
  DELETE FROM "Message" WHERE "id" IN (SELECT "id" FROM "_message_dedupe");

  DROP TABLE "_message_dedupe";

  -- 4. Enforce it. Prisma can't express an expression index, so it lives only in SQL; see the note on model Message.
  CREATE UNIQUE INDEX "Message_instanceId_key_unique"
    ON "Message" ("instanceId", ("key"->>'remoteJid'), ("key"->>'id'), (("key"->>'fromMe')::boolean));
END $$;
