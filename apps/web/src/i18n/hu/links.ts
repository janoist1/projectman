export const links = {
  kinds: {
    pull_request: 'PR',
    branch: 'Ág',
    issue: 'Issue',
    prerequisite: 'Előfeltétel',
    related: 'Kapcsolódik',
    duplicate_of: 'Duplikátuma',
    url: 'Link',
  },
  prStates: {
    open: 'nyitva',
    merged: 'merge-elve',
    closed: 'lezárva',
    draft: 'vázlat',
  },
  prLabel: 'PR #{number}',
  prLabelRepo: 'PR #{number} · {repo}',
  issueLabel: 'Issue #{number}',
} as const;
