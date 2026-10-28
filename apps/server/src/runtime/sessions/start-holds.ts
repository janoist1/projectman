import { conflict } from '../../kernel';

/**
 * Members whose sessions may not start for a moment (PM-1025): from the validation of a handle rename to the
 * announcement of the new configuration, a start would still go under the old handle. In memory only: a restart
 * ends the hold together with the process that held it.
 */
export class StartHolds {
  private readonly held = new Set<string>();

  /** Holds the member's starts; the returned function lifts the hold. Refused while another hold stands. */
  hold(projectKey: string, handle: string): () => void {
    const key = `${projectKey}\n${handle}`;
    if (this.held.has(key))
      throw conflict('member_renaming', `${handle} is being renamed`, { member: handle });
    this.held.add(key);
    return () => {
      this.held.delete(key);
    };
  }

  /** Refuses a start of the member while its handle is being renamed. */
  assertFree(projectKey: string, handle: string): void {
    if (this.held.has(`${projectKey}\n${handle}`))
      throw conflict('member_renaming', `${handle} is being renamed`, { member: handle });
  }
}
