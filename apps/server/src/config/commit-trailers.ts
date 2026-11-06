import { ActorCredential, hasBoundOrigin } from '@projectman/shared';
import type { Actor, BoundActor } from '@projectman/shared';

/** One line of the trailer paragraph `attributedMessage` (and the documents' `Projectman-Actor`) writes. */
const TRAILER_LINE =
  /^Projectman-(?:Actor|Via|Operator|Operator-Mode|Operator-Handle|Connected-Kind|Connected-Handle|Connected-Holder|Connected-Approved-By|Credential-Id|Credential-Prefix|Audit-Id|Request|Approved-By|Step|Request-Id|Agreement-Version|Approval-Mode): ?[^\r\n]*$/;

export interface CommitTrailers {
  /** The commit message without its trailer paragraph, trimmed. */
  message: string;
  /** The value of `Projectman-<name>`; undefined when the commit has no trailer paragraph or not this one. */
  trailer(name: string): string | undefined;
}

/**
 * The attribution trailers of a commit message. They are the last paragraph and only count when every line
 * of it is a known trailer: a user's own text cannot introduce attribution (`attributedMessage` defuses it).
 */
export function readCommitTrailers(raw: string): CommitTrailers {
  const body = raw.trim();
  const separator = body.lastIndexOf('\n\n');
  const ending = separator >= 0 ? body.slice(separator + 2) : '';
  const hasTrailers = ending.length > 0 && ending.split('\n').every((line) => TRAILER_LINE.test(line));
  return {
    message: hasTrailers ? body.slice(0, separator).trim() : body,
    trailer: (name) =>
      hasTrailers
        ? ending.match(new RegExp(`(?:^|\\n)Projectman-${name}: ?([^\\r\\n]*)`))?.[1]?.trim()
        : undefined,
  };
}

/**
 * The actor the trailers of a commit describe, or undefined unless they agree: the old super mode (PM-757:
 * mode, handle, credential) or the connected Claude (decision 66: kind, handle, holder, credential).
 */
export function actorFromTrailers(trailers: CommitTrailers): BoundActor | undefined {
  const { trailer } = trailers;
  const credential = ActorCredential.safeParse({
    id: trailer('Credential-Id'),
    prefix: trailer('Credential-Prefix'),
  });
  if (!credential.success) return undefined;
  const kind = trailer('Connected-Kind');
  const handle = trailer('Connected-Handle');
  const holder = trailer('Connected-Holder');
  const approvedBy = trailer('Connected-Approved-By');
  const operatorHandle = trailer('Operator-Handle');
  const actor: Actor | null =
    trailer('Operator-Mode') === 'super' && operatorHandle
      ? {
          kind: 'ai',
          handle: operatorHandle,
          via: 'integrator',
          operatorMode: 'super',
          credential: credential.data,
        }
      : (kind === 'human' || kind === 'ai') && handle && holder
        ? {
            kind,
            handle,
            via: 'integrator',
            through: { holder, credential: credential.data },
            ...(approvedBy ? { approvedBy } : {}),
          }
        : null;
  return actor && hasBoundOrigin(actor) ? actor : undefined;
}
