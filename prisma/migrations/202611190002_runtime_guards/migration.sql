-- Column UPDATE(id) may be granted for SELECT FOR SHARE without allowing key mutation.
CREATE FUNCTION protect_grant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.programme_id <> OLD.programme_id
 OR NEW.permission <> OLD.permission OR NEW.granted_by_id <> OLD.granted_by_id OR NEW.granted_at <> OLD.granted_at THEN
  RAISE EXCEPTION 'Immutable grant identity';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER grant_identity BEFORE UPDATE ON programme_grants FOR EACH ROW EXECUTE FUNCTION protect_grant_identity();
CREATE FUNCTION protect_user_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id THEN RAISE EXCEPTION 'Immutable user identity'; END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER user_identity BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION protect_user_identity();
