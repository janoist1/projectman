import { MAX_FIX_EXTRA_ROUNDS, memberOf } from '@projectman/shared';
import type {
  FixLimitDecisionPayload,
  FixLimitOptionId,
  FixRoundHistoryEntry,
  InboxOption,
  ProjectConfig,
} from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import type { TemplateLocale } from '@projectman/templates';

type FixLimitItemText = TemplateLocale['fixLimitItem'];

/** The three outcomes in the order the buttons always have (the position never jumps with the advice). */
const OPTION_ORDER: readonly FixLimitOptionId[] = ['replan', 'reassign', 'another_round'];

/** What the server writes into a fix round limit decision item (PM-714). */
export interface FixLimitItemContent {
  title: string;
  body: string;
  /** Only the options that can be carried out, with a real label and consequence in the project's language. */
  options: InboxOption[];
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** A short date and time in the project's time zone; the ISO text when the zone is unknown. */
function when(at: string, config: Pick<ProjectConfig, 'project'>): string {
  try {
    return new Intl.DateTimeFormat(getLocale(config.project.language).language, {
      timeZone: config.project.timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(at));
  } catch {
    return at.slice(0, 16).replace('T', ' ');
  }
}

function shortCommit(commit: string): string {
  return commit.slice(0, 8);
}

/** One line of the rounds list: its marker, the time, what happened and the first line of the note. */
function roundLine(
  entry: FixRoundHistoryEntry,
  text: FixLimitItemText,
  config: Pick<ProjectConfig, 'project' | 'team'>,
): string {
  const name = memberOf(config, entry.actor.handle)?.displayName ?? entry.actor.handle ?? 'system';
  const kinds = text.rounds.kind;
  const note = entry.note ? fill(text.rounds.note, { note: entry.note }) : '';
  let marker: string;
  let line: string;
  switch (entry.kind) {
    case 'code_review':
      marker = fill(text.rounds.counted, { n: entry.round ?? 0 });
      line = fill(kinds.code_review, { name }) + note;
      break;
    case 'design_review':
      marker = fill(text.rounds.counted, { n: entry.round ?? 0 });
      line = fill(kinds.design_review, { name }) + note;
      break;
    case 'tests_failed':
      marker = fill(text.rounds.counted, { n: entry.round ?? 0 });
      line = entry.command
        ? fill(kinds.tests_failed_command, { command: entry.command })
        : entry.commit
          ? fill(kinds.tests_failed_commit, { commit: shortCommit(entry.commit) })
          : kinds.tests_failed;
      break;
    case 'send_back':
      marker = fill(text.rounds.counted, { n: entry.round ?? 0 });
      line = entry.note ? fill(kinds.send_back, { name }) + note : fill(kinds.send_back_no_note, { name });
      break;
    case 'branch_moved': {
      marker = text.rounds.technicalMarker;
      const from = entry.pinned ? shortCommit(entry.pinned) : null;
      const to = entry.head ? shortCommit(entry.head) : null;
      line =
        (from && to ? fill(kinds.branch_moved_moves, { from, to }) : kinds.branch_moved) +
        text.rounds.notCounted;
      break;
    }
    case 'extra_round': {
      const index = entry.extraRound ?? 0;
      marker = fill(text.rounds.grantMarker, { n: index });
      line =
        fill(index > MAX_FIX_EXTRA_ROUNDS ? kinds.extra_round_over : kinds.extra_round, { index, name }) +
        note;
      break;
    }
  }
  return `${marker} ${when(entry.at, config)} · ${line}`;
}

/**
 * The body of a decision that was addressed to the integrator, now for the owners: the closing line about the
 * integrator is replaced by the owners' one. The body is returned as it was when it does not end with that line.
 */
export function bodyForOwners(config: Pick<ProjectConfig, 'project'>, body: string | null): string | null {
  const footer = getLocale(config.project.language).fixLimitItem.footer;
  if (!body?.endsWith(footer.integrator)) return body;
  return body.slice(0, body.length - footer.integrator.length) + footer.owner;
}

/**
 * The title, the full body and the options of a new fix round limit decision item (PM-714), in the
 * project's language. The body is what the integrator reads over MCP and the CLI, and what the web falls back
 * to: the summary, the extra rounds, the assessment of the lead (when it passed the card on), every round
 * and, per option, its id, label, consequence and the advice. `available` holds the options that can be
 * carried out now; the others are named in the body but are not in `options`, so nobody can pick them.
 */
export function formatFixLimitItem(
  config: Pick<ProjectConfig, 'project' | 'team'>,
  fixLimit: FixLimitDecisionPayload,
  available: readonly FixLimitOptionId[],
  recipient: 'owner' | 'integrator',
): FixLimitItemContent {
  const text = getLocale(config.project.language).fixLimitItem;
  const name = (handle: string | null) => (handle ? (memberOf(config, handle)?.displayName ?? handle) : '');
  const used = fixLimit.extraRounds ?? 0;
  const left = fixLimit.remainingExtraRounds ?? Math.max(0, MAX_FIX_EXTRA_ROUNDS - used);
  const testsFailed = fixLimit.testsFailed ?? 0;
  const parts = [
    fixLimit.changeRequests > 0 ? fill(text.parts.changes, { count: fixLimit.changeRequests }) : null,
    fixLimit.designChangeRequests > 0
      ? fill(text.parts.design, { count: fixLimit.designChangeRequests })
      : null,
    testsFailed > 0 ? fill(text.parts.testsFailed, { count: testsFailed }) : null,
    fixLimit.sendBacks - testsFailed > 0
      ? fill(text.parts.sendBacks, { count: fixLimit.sendBacks - testsFailed })
      : null,
  ]
    .filter(Boolean)
    .join(', ');
  const decider = name(fixLimit.decider);
  const reason = fill(text.reasons[fixLimit.reason], { name: decider });
  const lines: string[] = [
    fill(text.summary, { key: fixLimit.taskKey, rounds: fixLimit.rounds, parts, reason }),
  ];
  if (fixLimit.extraRounds !== undefined) {
    lines.push(
      fill(used > MAX_FIX_EXTRA_ROUNDS ? text.extras.over : left > 0 ? text.extras.left : text.extras.none, {
        used,
        left,
      }),
    );
  }
  const assessment = fixLimit.assessment;
  if (assessment) {
    lines.push(
      '',
      `${fill(text.verdict.title, { name: decider })}:`,
      `  ${text.verdict.repeat} ${assessment.recurrence}`,
      `  ${text.verdict.now} ${assessment.currentState}`,
    );
  }
  const history = fixLimit.history;
  if (history) {
    const counted = history.filter((entry) => entry.round !== null).length;
    const technical = history.filter((entry) => entry.kind === 'branch_moved').length;
    lines.push(
      '',
      fill(text.rounds.heading, { count: counted }) +
        (technical > 0 ? ` ${fill(text.rounds.technicalCount, { count: technical })}` : ''),
      ...history.map((entry) => `  ${roundLine(entry, text, config)}`),
    );
  }
  const recommended = assessment?.recommendation.optionId ?? null;
  const over = used >= MAX_FIX_EXTRA_ROUNDS;
  const label = (id: FixLimitOptionId) => text.options.label[id];
  const consequence = (id: FixLimitOptionId) =>
    id === 'another_round' && over
      ? text.options.consequence.another_round_over
      : text.options.consequence[id];
  lines.push('', text.options.heading);
  for (const id of OPTION_ORDER) {
    const advice =
      id === recommended
        ? ` (${fill(text.options.recommended, { reason: assessment?.recommendation.reason ?? '' })})`
        : '';
    const head = `- ${id} — ${label(id)}${advice}`;
    lines.push(
      head,
      `    ${available.includes(id) ? consequence(id) : text.options.unavailable[id as 'replan' | 'reassign']}`,
    );
  }
  lines.push('', recipient === 'integrator' ? text.footer.integrator : text.footer.owner);
  const options: InboxOption[] = OPTION_ORDER.filter((id) => available.includes(id)).map((id) => ({
    id,
    label: label(id),
    style: id === recommended ? 'primary' : 'secondary',
    consequence: consequence(id),
  }));
  return { title: fill(text.title, { key: fixLimit.taskKey }), body: lines.join('\n'), options };
}
