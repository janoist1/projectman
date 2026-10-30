import { z } from 'zod';
import type { ProjectConfig } from './schema';

/**
 * The owner topics (PM-1190): what only an owner decides. An AI member asks the owner for a decision only
 * under one of the project's topics (`team.ownerDecisionTopics`); everything else the project manager
 * answers, forwards to the technical decider, or makes an integrator todo. The hints are English prompt text.
 */
const BUILT_IN_OWNER_TOPICS = [
  {
    id: 'product_direction',
    hint: 'what the product does for its users, its scope, or the order of features the owner has not set yet',
  },
  {
    id: 'cost',
    hint: 'spending money or paid capacity: a subscription, a paid service, a purchase, a higher plan',
  },
  {
    id: 'external_party',
    hint: 'a client or another party outside the team: what they are told, promised, sent or asked',
  },
  {
    id: 'risk_acceptance',
    hint: 'accepting a risk that cannot be taken back: data loss, a security exposure, a production change, a public release',
  },
  {
    id: 'owner_only_setting',
    hint: 'members and their access, permissions, approval policy, the other changes only an owner may make in the settings',
  },
] as const;

/** The topic the system records for an approval question; reserved, a project never lists it. */
export const APPROVAL_OWNER_TOPIC = 'approval';

/** The topics a project starts with and an older configuration takes in (`TEAM_SETTING_POLICY`). */
export const DEFAULT_OWNER_DECISION_TOPICS: readonly OwnerDecisionTopic[] = BUILT_IN_OWNER_TOPICS.map(
  ({ id }) => ({
    id,
  }),
);

const MAX_OWNER_TOPICS = 12;
const builtInHint = (id: string): string | undefined =>
  BUILT_IN_OWNER_TOPICS.find((topic) => topic.id === id)?.hint;

/** One listed topic: a built-in one by its id (label and hint optional), a project's own with both. */
export const OwnerDecisionTopic = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().trim().min(1).max(60).optional(),
  hint: z.string().trim().min(1).max(300).optional(),
});
export type OwnerDecisionTopic = z.infer<typeof OwnerDecisionTopic>;

export const OwnerDecisionTopics = z
  .array(OwnerDecisionTopic)
  .max(MAX_OWNER_TOPICS)
  .superRefine((topics, ctx) => {
    const seen = new Set<string>();
    topics.forEach((topic, index) => {
      if (seen.has(topic.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate owner topic ${topic.id}` });
      seen.add(topic.id);
      if (topic.id === APPROVAL_OWNER_TOPIC)
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'approval is reserved for approvals' });
      else if (builtInHint(topic.id) === undefined && (topic.label === undefined || topic.hint === undefined))
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'an own owner topic needs a label and a hint',
        });
    });
  });

/** A topic as the rules and the prompt read it: a built-in topic's hint unless the project overrides it. */
export interface OwnerTopic {
  id: string;
  label: string | null;
  hint: string;
}

/** The project's owner topics in its order; absent: the default (`TEAM_SETTING_POLICY.ownerDecisionTopics`). */
export function ownerDecisionTopicsOf(config: Pick<ProjectConfig, 'team'>): OwnerTopic[] {
  return (config.team.ownerDecisionTopics ?? DEFAULT_OWNER_DECISION_TOPICS).map((topic) => ({
    id: topic.id,
    label: topic.label ?? null,
    hint: topic.hint ?? builtInHint(topic.id) ?? '',
  }));
}

export type OwnerTopicRefusal = 'owner_topic_required' | 'owner_topic_unknown';

/** Why an owner decision with this topic is refused: none given, or one the project does not list; null: it may go. */
export function ownerTopicRefusal(
  config: Pick<ProjectConfig, 'team'>,
  topic: string | undefined,
): OwnerTopicRefusal | null {
  if (topic === undefined) return 'owner_topic_required';
  return ownerDecisionTopicsOf(config).some((listed) => listed.id === topic) ? null : 'owner_topic_unknown';
}

/** The project's topics as prompt lines, `- id: hint`; the label follows the id when the project set one. */
export function ownerTopicLines(config: Pick<ProjectConfig, 'team'>): string[] {
  return ownerDecisionTopicsOf(config).map(
    (topic) => `- \`${topic.id}\`${topic.label ? ` (${topic.label})` : ''}: ${topic.hint}`,
  );
}

/** The refusal's message: what was wrong, the valid topics with their hints, and the other ways out. */
export function ownerTopicRefusalMessage(
  config: Pick<ProjectConfig, 'team'>,
  refusal: OwnerTopicRefusal,
): string {
  const lines = ownerTopicLines(config);
  const head =
    refusal === 'owner_topic_required'
      ? 'An owner decision needs owner_topic, the owner topic it falls under.'
      : 'owner_topic is not one of the project’s owner topics.';
  const topics =
    lines.length > 0
      ? `The project's owner topics:\n${lines.join('\n')}`
      : 'The project lists no owner topics: only approvals go to the owner.';
  return (
    `${refusal}: ${head}\n${topics}\n` +
    'Anything else is not the owner’s: answer it yourself with the recommended option when it can be ' +
    'reversed, forward it to the technical decider, or make it an integrator todo.'
  );
}
