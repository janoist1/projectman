export const memberEdit = {
  title: 'Edit member: {name}',
  edit: 'Edit',
  editMember: 'Edit {name}',
  roles: 'Roles held',
  instructions: 'Own instructions',
  autoCompactWindow: 'Compact the conversation above this size (tokens)',
  autoCompactWindowHint:
    'Left empty, the project’s value applies (under the project’s limits, 200,000 by default). You can set 100,000 to 1,000,000.',
  autoCompactWindowCodex:
    'Only applies to Claude members; it does not compact the conversation of {provider} members.',
  autoCompactWindowPlaceholder: 'the project’s value',
  limit: 'Up to how many points can a card they get have?',
  limitHint:
    'They are never given a card with more points automatically. They can always get an unscored card.',
  limitDefault: '5 points (default)',
  limitUnlimited: '13 points – any size',
  tempLimit:
    'As a stand-in they can get cards of up to {points|# point|# points}; the project’s Limits section sets this.',
  emailEnabled: 'Allow email correspondence',
  emailEnabledHint:
    'They can write to people who ask for email under Settings › Email, and they receive the replies.',
  emailChannelOff: 'No email goes out right now: email correspondence is switched off in the project.',
  emailChannelOffLink: 'Settings › Email',
  emailSendWithoutApproval: 'Can send without approval',
  emailApprovalHint: 'When off, every email of theirs goes to your For you list first.',
  emailAutoHint:
    'Their emails go out at once. Afterwards you can see them in the log under Settings › Email.',
  ownerOnly: 'Only the owner can change this.',
  machineAccess: 'Can give owners to-dos (MCP)',
  machineAccessHint:
    'They can put installs and settings in the owners’ queue. The owner’s Claude, connected over MCP, works through the queue.',
  save: 'Save',
  saved: 'The member’s details are saved.',
} as const;
