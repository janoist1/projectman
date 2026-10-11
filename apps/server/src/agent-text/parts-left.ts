/**
 * The one reminder a member gets when parts of a card they broke down are still left in the first stage
 * (PM-480). It names what to do, never does it: the member moves and labels the parts (decision 48).
 */
export interface PartsLeftText {
  parentKey: string;
  parts: { key: string; title: string }[];
  /** The stage the parts are left in, as the member sees it. */
  firstStage: string;
  /** The stage a part that can start goes to. */
  target: string;
  /** The label for a part that cannot start yet. */
  refineLabel: string;
}

export function partsLeftText(input: PartsLeftText): string {
  const { parentKey, parts, firstStage, target, refineLabel } = input;
  const list = parts.map((part) => `${part.key} "${part.title}"`).join(', ');
  return [
    `You broke ${parentKey} down, and ${parts.length} of its parts ${parts.length === 1 ? 'is' : 'are'} still in ${firstStage}, where nobody starts ${parts.length === 1 ? 'it' : 'them'}: ${list}.`,
    `Take each one out now: add the labels the gates up to ${target} ask for, with their reasons, and move it to ${target} with update_task; or, if it cannot start yet, add \`${refineLabel}\` and write in its description what it lacks.`,
    `Give their order as prerequisite relations, then note on ${parentKey} where each part went.`,
    'You are told this once; if they are still left after this turn, the owner is told.',
  ].join('\n');
}
