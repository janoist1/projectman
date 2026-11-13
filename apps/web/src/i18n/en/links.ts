export const links = {
  kinds: {
    pull_request: 'PR',
    branch: 'Branch',
    issue: 'Issue',
    prerequisite: 'Prerequisite',
    related: 'Related to',
    duplicate_of: 'Duplicate of',
    url: 'Link',
  },
  prStates: { open: 'open', merged: 'merged', closed: 'closed', draft: 'draft' },
  prLabel: 'PR #{number}',
  prLabelRepo: 'PR #{number} · {repo}',
  issueLabel: 'Issue #{number}',
} as const;
