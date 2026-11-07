-- Chat state synced from WhatsApp (see #1): archived / pinned / muted / marked-as-unread.
-- muteEndTime is the mute end timestamp WhatsApp sends (-1 = muted forever, NULL = not muted).
ALTER TABLE "Chat"
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "muteEndTime" BIGINT,
  ADD COLUMN "markedAsUnread" BOOLEAN NOT NULL DEFAULT false;
