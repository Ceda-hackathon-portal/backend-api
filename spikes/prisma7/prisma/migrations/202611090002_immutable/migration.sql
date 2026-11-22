-- Demonstrates reviewed SQL outside Prisma's schema vocabulary; generic fixture only.
CREATE FUNCTION spike_reject_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'spike snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER spike_snapshot_immutable BEFORE UPDATE OR DELETE ON spike_snapshots
FOR EACH ROW EXECUTE FUNCTION spike_reject_snapshot_change();
