exports.up = (pgm) =>
  pgm.sql(`
CREATE TABLE demo_sessions (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count BETWEEN 0 AND 10)
);
CREATE INDEX sessions_expiry ON demo_sessions(expires_at);
CREATE TABLE events (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE,
 event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_owner ON events(session_id, created_at);
CREATE TABLE deliveries (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 replay_parent_id uuid, receiver jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_progress','retry_wait','succeeded','dead_lettered')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
 generation integer NOT NULL DEFAULT 1 CHECK (generation > 0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid, lease_until timestamptz, final_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(id, event_id),
 FOREIGN KEY(replay_parent_id, event_id) REFERENCES deliveries(id, event_id) ON DELETE CASCADE,
 CHECK ((state = 'in_progress') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
 CHECK ((state IN ('succeeded','dead_lettered')) = (completed_at IS NOT NULL)),
 CHECK ((state = 'dead_lettered') = (final_reason IS NOT NULL)),
 CHECK (jsonb_typeof(receiver) = 'object' AND receiver->>'behaviour' IN ('always_succeed','fail_then_succeed','always_fail','timeout','rate_limit'))
);
CREATE INDEX deliveries_event ON deliveries(event_id, created_at DESC, id DESC);
CREATE INDEX deliveries_due ON deliveries(next_attempt_at) WHERE state IN ('pending','retry_wait');
CREATE INDEX deliveries_leases ON deliveries(lease_until) WHERE state = 'in_progress';
CREATE TABLE delivery_attempts (
 delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE, attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 5),
 outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','succeeded','failed','interrupted')),
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 http_status integer CHECK (http_status BETWEEN 100 AND 599), duration_ms integer CHECK(duration_ms >= 0),
 response_excerpt text, error_code text,
 PRIMARY KEY(delivery_id, attempt_number), CHECK ((outcome = 'started') = (finished_at IS NULL)),
 CHECK (response_excerpt IS NULL OR octet_length(response_excerpt) <= 2052)
);
CREATE UNIQUE INDEX one_started_attempt ON delivery_attempts(delivery_id) WHERE outcome = 'started';
CREATE TABLE idempotency_requests (
 session_id uuid NOT NULL REFERENCES demo_sessions(id) ON DELETE CASCADE, operation text NOT NULL,
 key text NOT NULL, fingerprint text NOT NULL, event_id uuid REFERENCES events(id) ON DELETE CASCADE,
 delivery_id uuid REFERENCES deliveries(id) ON DELETE CASCADE, PRIMARY KEY(session_id, operation, key)
);
CREATE TABLE delivery_outbox (
 delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE, generation integer NOT NULL,
 eligible_at timestamptz NOT NULL, published_at timestamptz, publish_count integer NOT NULL DEFAULT 0 CHECK (publish_count BETWEEN 0 AND 3),
 lease_token uuid, lease_until timestamptz,
 PRIMARY KEY(delivery_id, generation), CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX outbox_pending ON delivery_outbox(eligible_at) WHERE published_at IS NULL;
CREATE TABLE demo_daily_usage (
 day date PRIMARY KEY, delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count BETWEEN 0 AND 50)
);
CREATE FUNCTION protect_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Events are immutable'; END $$;
CREATE TRIGGER immutable_event BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION protect_event();
CREATE FUNCTION protect_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.outcome <> 'started' THEN RAISE EXCEPTION 'Completed attempts are immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_completed_attempt BEFORE UPDATE ON delivery_attempts FOR EACH ROW EXECUTE FUNCTION protect_attempt();
`);
exports.down = (pgm) =>
  pgm.sql(
    `DROP TABLE demo_daily_usage, delivery_outbox, idempotency_requests, delivery_attempts, deliveries, events, demo_sessions CASCADE; DROP FUNCTION protect_event(), protect_attempt();`,
  );
