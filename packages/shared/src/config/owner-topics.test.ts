import { describe, expect, it } from 'vitest';
import {
  OwnerDecisionTopics,
  ownerDecisionTopicsOf,
  ownerTopicRefusal,
  ownerTopicRefusalMessage,
  type OwnerDecisionTopic,
} from './owner-topics';
import { ProjectConfig } from './schema';

function config(ownerDecisionTopics?: OwnerDecisionTopic[]) {
  return {
    team: ProjectConfig.shape.team.parse({
      limits: {},
      members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' }],
      ...(ownerDecisionTopics ? { ownerDecisionTopics } : {}),
    }),
  };
}

describe('ownerTopicRefusal', () => {
  it('requires a topic', () => {
    expect(ownerTopicRefusal(config(), undefined)).toBe('owner_topic_required');
  });

  it('refuses a topic the project does not list', () => {
    expect(ownerTopicRefusal(config([{ id: 'cost' }]), 'product_direction')).toBe('owner_topic_unknown');
  });

  it('lets a listed topic through, the built-in ones when the project lists none', () => {
    expect(ownerTopicRefusal(config(), 'risk_acceptance')).toBeNull();
    expect(
      ownerTopicRefusal(config([{ id: 'hiring', label: 'Hiring', hint: 'who joins' }]), 'hiring'),
    ).toBeNull();
  });

  it('refuses every topic of an empty list, approval too', () => {
    expect(ownerTopicRefusal(config([]), 'cost')).toBe('owner_topic_unknown');
    expect(ownerTopicRefusal(config([]), 'approval')).toBe('owner_topic_unknown');
  });
});

describe('ownerDecisionTopicsOf', () => {
  it("fills a built-in topic's hint unless the project overrides it", () => {
    const [cost, risk] = ownerDecisionTopicsOf(
      config([{ id: 'cost' }, { id: 'risk_acceptance', hint: 'own' }]),
    );
    expect(cost!.hint).not.toBe('');
    expect(risk!.hint).toBe('own');
  });
});

describe('ownerTopicRefusalMessage', () => {
  it('starts with the code and lists the valid topics', () => {
    const message = ownerTopicRefusalMessage(config([{ id: 'cost' }]), 'owner_topic_unknown');
    expect(message.startsWith('owner_topic_unknown:')).toBe(true);
    expect(message).toContain('`cost`');
    expect(message).not.toContain('`product_direction`');
  });
});

describe('OwnerDecisionTopics', () => {
  it.each([
    ['a duplicate id', [{ id: 'cost' }, { id: 'cost' }]],
    ['the reserved approval', [{ id: 'approval', label: 'Approval', hint: 'approvals' }]],
    ['an own topic without a hint', [{ id: 'hiring', label: 'Hiring' }]],
    ['an id that is no identifier', [{ id: 'Cost', label: 'Cost', hint: 'money' }]],
  ])('refuses %s', (_, topics) => {
    expect(OwnerDecisionTopics.safeParse(topics).success).toBe(false);
  });

  it('accepts an empty list and an own topic with label and hint', () => {
    expect(OwnerDecisionTopics.safeParse([]).success).toBe(true);
    expect(
      OwnerDecisionTopics.safeParse([{ id: 'hiring', label: 'Hiring', hint: 'who joins' }]).success,
    ).toBe(true);
  });
});
