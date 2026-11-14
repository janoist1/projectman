-- PM-1437: device pairing for the friend install. A machine asks for a short code with the hashes of the keys it
-- made; its owner approves the code, and the hub makes the engine and the integrator key from those hashes. Only
-- the SHA-256 of the code is kept. A pending row past `expires_at` is expired; approved and denied rows stay as
-- the record of the decision. `engines.pairing_id` and `integrator_keys.pairing_id` name the pairing an engine
-- or a key came from (NULL for one made by hand).
CREATE TABLE engine_pairings (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  machine_key_hash TEXT NOT NULL,
  machine_key_prefix TEXT NOT NULL,
  integrator_key_hash TEXT NOT NULL,
  integrator_key_prefix TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied','cancelled')),
  decided_by TEXT,
  decided_at TEXT,
  engine_id TEXT,
  integrator_key_id TEXT
);
CREATE UNIQUE INDEX engine_pairings_pending_code ON engine_pairings(code_hash) WHERE state = 'pending';
ALTER TABLE engines ADD COLUMN pairing_id TEXT;
ALTER TABLE integrator_keys ADD COLUMN pairing_id TEXT;
