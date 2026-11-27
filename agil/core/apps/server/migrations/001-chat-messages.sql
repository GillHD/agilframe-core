BEGIN;

-- Serialize startup migrations for Cores which share the same database.
SELECT pg_advisory_xact_lock(1745227930, 1);

CREATE TABLE IF NOT EXISTS agil_chat_messages (
  tenant_id text NOT NULL,
  room_id text NOT NULL,
  room_instance_id text NOT NULL CHECK (room_instance_id <> ''),
  message_id text NOT NULL,
  sent_at_ms bigint NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, room_id, room_instance_id, message_id)
);

CREATE INDEX IF NOT EXISTS agil_chat_messages_recent
  ON agil_chat_messages (tenant_id, room_id, room_instance_id, sent_at_ms DESC, message_id DESC);

CREATE INDEX IF NOT EXISTS agil_chat_messages_archive
  ON agil_chat_messages (tenant_id, room_id, stored_at DESC, room_instance_id DESC);

CREATE INDEX IF NOT EXISTS agil_chat_messages_expiry
  ON agil_chat_messages (expires_at);

COMMIT;
