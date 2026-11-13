export const ownerTopics = {
  approval: 'Approval',
  why: 'Why you:',
  builtIn: {
    product_direction: {
      label: 'Product direction',
      hint: 'What to build, what to leave out, what matters more.',
    },
    cost: { label: 'Cost', hint: 'Money: subscriptions, paid services, budgets.' },
    external_party: {
      label: 'Client or external party',
      hint: 'Anything that reaches a client, a partner or the public.',
    },
    risk_acceptance: {
      label: 'Accepting a risk',
      hint: 'Taking on data loss, a security risk or a step that cannot be undone.',
    },
    owner_only_setting: {
      label: 'Owner setting',
      hint: 'Members and their access, permissions, approval rules.',
    },
  },
} as const;
