import { dutyMembers } from '../config/duties';
import { isOnLeave } from '../config/leave';
import { memberOf } from '../config/lookup';
import { DEFAULT_LOOP_WATCH } from '../config/schema';
import type { LoopWatch, ProjectConfig, TeamLimits } from '../config/schema';
import type { DutyId } from './duty';
import type { TimelineEvent } from './event';

/**
 * The loop watch (PM-261, replacing the message storm alert of PM-186), shared by the server and the web's
 * fake backend. AI members writing to each other on a card, with no progress in between, are a loop:
 * not the traffic on the card but the same members going round without anything changing.
 */

const MINUTE_MS = 60_000;

/** The duty whose AI holder is told first: following stuck work and reminding the next one is its job. */
export const LOOP_WATCH_DUTY: DutyId = 'scheduling';

/** One team message of a card: when, who wrote it and who it went to. */
export interface LoopTalk {
  at: string;
  from: string;
  to: string[];
}

/** What a loop is made of: the counted messages and who took part. */
export interface LoopFinding {
  count: number;
  /** Senders and recipients of the counted messages, in alphabetical order. */
  members: string[];
  /** The first counted message (ISO time). */
  startedAt: string;
  /** The last counted message (ISO time). */
  lastMessageAt: string;
}

/** The watch a project's limits set, else the default. */
export function loopWatchOf(limits: Pick<TeamLimits, 'loopWatch'> | undefined): LoopWatch {
  return limits?.loopWatch ?? DEFAULT_LOOP_WATCH;
}

/**
 * Whether a team message counts for the loop watch: its sender and every recipient are AI members. A
 * message of a person or of the system, and one to a person, is not the members going round among
 * themselves. `ignore` are the members already told about the loop: what they write, and what is
 * written only to them, is no longer the loop's talk.
 */
export function countsForLoop(
  config: Pick<ProjectConfig, 'team'>,
  talk: Pick<LoopTalk, 'from' | 'to'>,
  ignore: readonly string[],
): boolean {
  const isAi = (handle: string) => memberOf(config, handle)?.kind === 'ai';
  if (!isAi(talk.from) || ignore.includes(talk.from)) return false;
  return talk.to.length > 0 && talk.to.every(isAi) && talk.to.some((handle) => !ignore.includes(handle));
}

/**
 * Whether a timeline event is the work of a card (PM-431), and so progress that ends a loop and
 * starts the count again: a note (an imported comment is history, not work), an attachment, a new
 * description. For a team that does not write code this is what getting on looks like. The SQL of
 * `latestWork` in the server's timeline repository states the same rule.
 */
export function isLoopWork(event: Pick<TimelineEvent, 'type' | 'data'>): boolean {
  switch (event.type) {
    case 'attachment_added':
      return true;
    case 'task_note':
      return event.data.importedAuthor === undefined && event.data.importedAt === undefined;
    case 'task_updated':
      return Array.isArray(event.data.fields) && event.data.fields.includes('description');
    default:
      return false;
  }
}

/**
 * The loop the talk of a card makes at `now`, or null. `talk` are the counted messages (see
 * `countsForLoop`) of the card; `since` (ISO time) is its last progress: a stage or label change, a
 * commit, the end of an earlier loop. A loop is `count` messages after `since` and within the last
 * `minutes` minutes, from at least two different senders (one member writing alone is not a round).
 * `since` is the last progress, and the work of the card (`isLoopWork`) is progress too.
 */
export function findLoop(
  talk: readonly LoopTalk[],
  since: string,
  now: string,
  watch: LoopWatch,
): LoopFinding | null {
  if (!watch.enabled) return null;
  const from = Math.max(Date.parse(since), Date.parse(now) - watch.minutes * MINUTE_MS);
  const counted = talk
    .filter((entry) => {
      const at = Date.parse(entry.at);
      return at > Date.parse(since) && at >= from && at <= Date.parse(now);
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (counted.length < watch.count) return null;
  if (new Set(counted.map((entry) => entry.from)).size < 2) return null;
  return {
    count: counted.length,
    members: [...new Set(counted.flatMap((entry) => [entry.from, ...entry.to]))].sort(),
    startedAt: counted[0]!.at,
    lastMessageAt: counted[counted.length - 1]!.at,
  };
}

/**
 * The AI members who hold `LOOP_WATCH_DUTY`, in the configuration's order, without those on leave
 * and without `exclude` (the members taking part in the loop): the first is told.
 */
export function loopWatchers(config: Pick<ProjectConfig, 'team'>, exclude: readonly string[]): string[] {
  return dutyMembers(config, LOOP_WATCH_DUTY)
    .filter((member) => member.kind === 'ai' && !isOnLeave(member) && !exclude.includes(member.handle))
    .map((member) => member.handle);
}

/**
 * The people who decide when the loop reaches a person (nobody holds the duty, the admission refused
 * the AI member, or the loop went on after it was told): the owners and admins who hold
 * `LOOP_WATCH_DUTY`; when there is none, `owners`.
 */
export function loopDeciders(config: Pick<ProjectConfig, 'team'>, owners: readonly string[]): string[] {
  const holders = dutyMembers(config, LOOP_WATCH_DUTY)
    .filter((member) => member.kind === 'human' && (member.access === 'owner' || member.access === 'admin'))
    .map((member) => member.handle);
  return holders.length > 0 ? holders : [...owners];
}
