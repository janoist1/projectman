/** A step made through a connected Claude (decision 66, PM-1075). */
export const connected = {
  chip: 'Claude',
  chipHolder: 'Claude · {holder}',
  approvedBy: 'approved by {name}',
  label: '{name} (Claude)',
  labelHolder: '{name} (Claude · {holder})',
  via: '{name} · via connected Claude',
  title: 'Connected Claude',
  chipAria: 'Connected Claude, held by {holder}. Details',
  avatar: '{name}, through a connected Claude',
  detail: 'Connected Claude',
  holder: 'held by {name}',
  key: 'key:',
  activity: 'What did this key do?',
} as const;
