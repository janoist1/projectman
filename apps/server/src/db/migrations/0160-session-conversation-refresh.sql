-- PM-1461: where the refresh of a session's conversation stands (JSON: state, reason, requestedAt, the note and
-- its time). Only the project manager's general session has one; NULL is no refresh. No old row needs a backfill.
ALTER TABLE sessions ADD COLUMN conversation_refresh TEXT;
