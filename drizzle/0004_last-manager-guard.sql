-- A workspace always keeps at least one manager, whoever deletes the row: removeMember(), a direct UPDATE, or the
-- cascade from deleting the manager's account (admin "remove user"). The app code checks the same rule first to
-- answer with a friendly 409; this trigger is the backstop that holds for every other path.
-- Lock ordering: the trigger takes the workspace row lock (FOR UPDATE) per membership row it removes. Application code
-- (withWorkspace, account-removal.ts) takes workspace locks first, in id order, so it doesn't deadlock with itself.
-- Two concurrent deletions of accounts that manage the same workspaces in a different order could still deadlock in
-- this backstop path; Postgres aborts one of them and the caller can retry. That is acceptable for a rare admin action.
CREATE FUNCTION membership_keep_a_manager() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role <> 'manager' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'manager' AND NEW.workspace_id = OLD.workspace_id AND NEW.user_id = OLD.user_id THEN
    RETURN NEW;
  END IF;
  -- Serialize with every other change to this workspace's managers (two managers leaving at once). Re-entrant for
  -- code that already holds the lock. No row means the workspace itself is being deleted (cascade): nothing to keep.
  PERFORM 1 FROM workspace WHERE id = OLD.workspace_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM membership WHERE workspace_id = OLD.workspace_id AND role = 'manager' AND user_id <> OLD.user_id
  ) THEN
    RAISE EXCEPTION 'A workspace needs at least one manager' USING ERRCODE = 'check_violation', CONSTRAINT = 'membership_last_manager';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER membership_keep_a_manager BEFORE UPDATE OF role, workspace_id, user_id OR DELETE ON membership
  FOR EACH ROW EXECUTE FUNCTION membership_keep_a_manager();
