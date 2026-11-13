-- PM-1395: whom a step stage with a small-card rule gave the card to on entry (JSON `StageOwnerPick`); NULL:
  -- the stage has no such rule. No old row needs a backfill: every card read before keeps the stage's owners.
ALTER TABLE tasks ADD COLUMN stage_owner_pick TEXT;
