-- One-time backfill for accounts whose history was imported before #24 / #1 (see issue #24).
--
-- History-synced incoming messages were stored as DELIVERY_ACK (unread), so imported chats count thousands of unread
-- messages and every new message recounts all of them. This marks incoming DELIVERY_ACK messages older than a cutoff
-- as READ, in small committed batches, then recomputes the instance's Chat.unreadMessages counters.
--
-- Run it per instance, at a quiet hour, against the Evolution database:
--
--   psql "$DATABASE_CONNECTION_URI" \
--     -v instance_name='my-instance' \
--     -v cutoff=1762387200 \
--     -f Docker/scripts/backfill_history_unread.sql
--
-- cutoff: epoch SECONDS. Messages older than it are treated as history the phone already has. Use the time the
--         account was (last) paired / its history imported. Messages after it keep their status.
--
-- Safe to re-run (it only touches rows still at DELIVERY_ACK). Expect WAL and dead tuples on large accounts;
-- autovacuum handles them, or run VACUUM (ANALYZE) "Message" afterwards.

\set ON_ERROR_STOP on

SELECT id AS instance_id FROM "Instance" WHERE name = :'instance_name' \gset
SELECT set_config('backfill.instance_id', :'instance_id', false),
       set_config('backfill.cutoff', :'cutoff', false);

SELECT count(*) AS rows_to_mark_read
FROM "Message"
WHERE "instanceId" = :'instance_id'
  AND "status" = 'DELIVERY_ACK'
  AND COALESCE(("key"->>'fromMe')::boolean, false) = false
  AND "messageTimestamp" < :cutoff;

DO $$
DECLARE
  batch_rows integer;
  total_rows integer := 0;
BEGIN
  LOOP
    UPDATE "Message"
    SET "status" = 'READ'
    WHERE "id" IN (
      SELECT "id" FROM "Message"
      WHERE "instanceId" = current_setting('backfill.instance_id')
        AND "status" = 'DELIVERY_ACK'
        AND COALESCE(("key"->>'fromMe')::boolean, false) = false
        AND "messageTimestamp" < current_setting('backfill.cutoff')::integer
      LIMIT 5000
    );
    GET DIAGNOSTICS batch_rows = ROW_COUNT;
    total_rows := total_rows + batch_rows;
    COMMIT;
    EXIT WHEN batch_rows = 0;
    PERFORM pg_sleep(0.2);
  END LOOP;
  RAISE NOTICE 'Marked % messages READ', total_rows;
END $$;

-- Recompute every chat counter of the instance from what is still unread.
UPDATE "Chat" AS c
SET "unreadMessages" = COALESCE(u.n, 0)
FROM "Chat" AS c2
LEFT JOIN (
  SELECT "key"->>'remoteJid' AS jid, count(*)::integer AS n
  FROM "Message"
  WHERE "instanceId" = :'instance_id'
    AND "status" = 'DELIVERY_ACK'
    AND COALESCE(("key"->>'fromMe')::boolean, false) = false
  GROUP BY 1
) AS u ON u.jid = c2."remoteJid"
WHERE c."id" = c2."id"
  AND c."instanceId" = :'instance_id'
  AND c."unreadMessages" IS DISTINCT FROM COALESCE(u.n, 0);
