import { z } from 'zod';
import { MemberHandle } from './member';
import { SessionState } from './session';
import { TaskKey } from './task';

export const CardBusyGroup = z.object({
  role: z.string(),
  working: z.array(z.object({ handle: MemberHandle, state: SessionState })),
  joining: z.array(MemberHandle).min(1),
});
export type CardBusyGroup = z.infer<typeof CardBusyGroup>;

export const CardBusyDetails = z.object({
  taskKey: TaskKey,
  groups: z.array(CardBusyGroup).min(1),
});
export type CardBusyDetails = z.infer<typeof CardBusyDetails>;

/** Same-role collisions, in first role occurrence and input handle order. */
export function cardBusyGroups(input: {
  working: readonly { handle: string; role: string; state: SessionState }[];
  joining: readonly { handle: string; role: string }[];
}): CardBusyGroup[] {
  const groups = new Map<string, CardBusyGroup>();
  const groupFor = (role: string) => {
    let group = groups.get(role);
    if (!group) {
      group = { role, working: [], joining: [] };
      groups.set(role, group);
    }
    return group;
  };
  for (const { handle, role, state } of input.working) groupFor(role).working.push({ handle, state });
  for (const { handle, role } of input.joining) groupFor(role).joining.push(handle);
  return [...groups.values()].filter(
    (group) => group.joining.length > 0 && group.working.length + group.joining.length >= 2,
  );
}
