CREATE TABLE support_conversations (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
 programme_id uuid NOT NULL REFERENCES programmes(id), application_id uuid REFERENCES applications(id),
 subject varchar(160) NOT NULL, agent_id uuid REFERENCES users(id),
 status varchar(16) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 first_reply_at timestamptz, resolved_at timestamptz,
 UNIQUE(id, owner_id)
);
CREATE INDEX support_queue_idx ON support_conversations(programme_id, status, updated_at);
CREATE INDEX support_owner_idx ON support_conversations(owner_id, updated_at);
CREATE TABLE support_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES support_conversations(id),
 sender_id uuid NOT NULL REFERENCES users(id), client_id uuid NOT NULL,
 body varchar(4000) NOT NULL CHECK (length(trim(body)) > 0), internal boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id, sender_id, client_id)
);
CREATE INDEX support_messages_cursor_idx ON support_messages(conversation_id, created_at, id);
CREATE TABLE support_reads (
 conversation_id uuid NOT NULL REFERENCES support_conversations(id), user_id uuid NOT NULL REFERENCES users(id),
 read_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE support_agents (
 user_id uuid PRIMARY KEY REFERENCES users(id), available boolean NOT NULL DEFAULT false,
 last_seen_at timestamptz NOT NULL DEFAULT now(), capacity int NOT NULL DEFAULT 4 CHECK(capacity BETWEEN 1 AND 10)
);
CREATE TABLE support_calls (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES support_conversations(id),
 caller_id uuid NOT NULL REFERENCES users(id), callee_id uuid NOT NULL REFERENCES users(id),
 state varchar(16) NOT NULL CHECK (state IN ('RINGING','ACCEPTED','DECLINED','ENDED','MISSED')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
 caller_seen_at timestamptz NOT NULL DEFAULT now(), callee_seen_at timestamptz NOT NULL DEFAULT now(),
 CHECK(caller_id <> callee_id)
);
CREATE UNIQUE INDEX support_one_call_idx ON support_calls(conversation_id) WHERE state IN ('RINGING','ACCEPTED');
CREATE TABLE support_signals (
 sequence bigserial PRIMARY KEY, call_id uuid NOT NULL REFERENCES support_calls(id),
 sender_id uuid NOT NULL REFERENCES users(id), client_id uuid NOT NULL,
 kind varchar(16) NOT NULL CHECK(kind IN ('offer','answer','candidate')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(call_id,sender_id,client_id)
);
CREATE TABLE service_audits (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), programme_id uuid REFERENCES programmes(id),
 target_id uuid NOT NULL, action varchar(100) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_audit_idx ON service_audits(programme_id,created_at);
CREATE TABLE alert_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id), in_app boolean NOT NULL DEFAULT true,
 email boolean NOT NULL DEFAULT false, email_since timestamptz, consent_version varchar(32), consent_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_notifications (
 id uuid PRIMARY KEY, recipient_id uuid NOT NULL REFERENCES users(id), source_key varchar(160) NOT NULL,
 title varchar(160) NOT NULL, href varchar(300) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz, email_state varchar(16) NOT NULL DEFAULT 'PENDING',
 attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, last_error varchar(64), UNIQUE(recipient_id,source_key)
);
CREATE INDEX service_notifications_inbox_idx ON service_notifications(recipient_id,created_at);
CREATE TABLE privacy_requests (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), kind varchar(16) NOT NULL CHECK(kind IN ('EXPORT','DELETE')),
 status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','REVIEWED','COMPLETED','DECLINED')),
 reason varchar(2000), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX privacy_request_pending_idx ON privacy_requests(user_id,kind) WHERE status='PENDING';

CREATE FUNCTION service_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Service audit records are append-only' USING ERRCODE='42501'; END; $$;
CREATE TRIGGER service_audit_immutable BEFORE UPDATE OR DELETE ON service_audits FOR EACH ROW EXECUTE FUNCTION service_audit_immutable();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ceda_runtime') THEN
   GRANT SELECT,INSERT,UPDATE ON support_conversations,support_reads,support_agents,support_calls,alert_preferences,service_notifications,privacy_requests TO ceda_runtime;
   GRANT SELECT,INSERT ON support_messages,service_audits TO ceda_runtime;
   GRANT SELECT,INSERT,DELETE ON support_signals TO ceda_runtime;
   GRANT USAGE,SELECT ON SEQUENCE support_signals_sequence_seq TO ceda_runtime;
   GRANT SELECT ON decision_audits TO ceda_runtime;
 END IF;
END $$;

CREATE INDEX applications_reporting_idx ON applications(programme_id,created_at);
CREATE INDEX submissions_reporting_idx ON submission_versions(submitted_at,application_id);
CREATE INDEX releases_reporting_idx ON outcome_releases(programme_id,created_at);
CREATE INDEX service_notice_delivery_idx ON service_notifications(email_state,next_attempt_at) WHERE email_state IN ('PENDING','RETRY');
