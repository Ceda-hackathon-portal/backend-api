BEGIN;

LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE;

-- Serialize session issuance with account status changes.
CREATE FUNCTION require_active_session_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM users WHERE id = NEW.user_id AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account unavailable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER check_session_user BEFORE INSERT ON sessions
FOR EACH ROW EXECUTE FUNCTION require_active_session_user();

CREATE FUNCTION revoke_suspended_user_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
  WHERE user_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER revoke_sessions_on_suspension AFTER UPDATE OF status ON users
FOR EACH ROW WHEN (NEW.status = 'SUSPENDED' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION revoke_suspended_user_sessions();

UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE status = 'SUSPENDED');

COMMIT;
