import type { Db } from './database';

export type DecisionVerdict = 'recorded' | 'declined' | 'skipped';

/** What the owner said about one answered question the Operator offered as a decision (PM-496). */
export interface DecisionOfferRecord {
  projectKey: string;
  itemId: string;
  verdict: DecisionVerdict;
  /** The entry number when recorded. */
  decision: string | null;
  requestId: string;
  decidedAt: string;
}

/** Where the candidate search of a project starts and when the Operator last looked. */
export interface DecisionCandidateState {
  /** Answers at or before this are no candidates. */
  since: string;
  listedAt: string | null;
}

const columns = `project_key AS projectKey, item_id AS itemId, verdict, decision, request_id AS requestId,
  decided_at AS decidedAt`;

export function createDecisionOfferRepository(db: Db) {
  return {
    get(projectKey: string, itemId: string): DecisionOfferRecord | null {
      return (
        (db
          .prepare(`SELECT ${columns} FROM decision_offers WHERE project_key = ? AND item_id = ?`)
          .get(projectKey, itemId) as DecisionOfferRecord | undefined) ?? null
      );
    },
    /** Records the verdict; an item already marked is overwritten (the owner asked for it). */
    upsert(offer: DecisionOfferRecord): void {
      db.prepare(
        `INSERT INTO decision_offers (project_key, item_id, verdict, decision, request_id, decided_at)
         VALUES (@projectKey, @itemId, @verdict, @decision, @requestId, @decidedAt)
         ON CONFLICT (project_key, item_id) DO UPDATE SET verdict = excluded.verdict,
           decision = excluded.decision, request_id = excluded.request_id, decided_at = excluded.decided_at`,
      ).run(offer);
    },
    /** A project with no row has no lower bound (a new project). */
    state(projectKey: string): DecisionCandidateState | null {
      return (
        (db
          .prepare('SELECT since, listed_at AS listedAt FROM decision_candidate_state WHERE project_key = ?')
          .get(projectKey) as DecisionCandidateState | undefined) ?? null
      );
    },
    markListed(projectKey: string, at: string): void {
      db.prepare(
        `INSERT INTO decision_candidate_state (project_key, since, listed_at) VALUES (?, '', ?)
         ON CONFLICT (project_key) DO UPDATE SET listed_at = excluded.listed_at`,
      ).run(projectKey, at);
    },
  };
}
