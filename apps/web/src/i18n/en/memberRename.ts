/** Renaming an AI member’s handle (PM-1026). */
export const memberRename = {
  menu: 'Rename handle',
  menuFor: 'Rename the handle of {name}',
  title: 'Rename the handle of {name}',
  intro:
    'This handle is how they are referred to in the team, on cards and in messages. Their name does not change.',
  label: 'New handle',
  hint: 'Lower case, digits and hyphens, up to 32 characters. Now: {handle}',
  consequencesTitle: 'What happens?',
  carriesOn:
    'Their cards, messages and jobs carry on under the new handle; their workspace and conversations stay.',
  oldHandleReserved:
    'The old handle ({handle}) stays reserved: no other member can take it, and old references lead here.',
  emailFollows: 'Their email address becomes {address}; emails sent to the old address still reach them.',
  emailFollowsNoDomain:
    'Their email address follows the new handle; emails sent to the old address still reach them.',
  newHandle: 'new handle',
  notWhileWorking: 'They can’t be renamed while they are working.',
  submit: 'Rename',
  submitting: 'Renaming…',
  done: 'Renamed: {from} → {to}',
  invalid:
    'It must start with a lower case letter or a digit and can only hold lower case letters, digits and hyphens (up to 32 characters).',
  unchanged: 'That is their current handle. Enter a new one.',
  taken: 'The handle “{handle}” is taken: a member uses or used it. Pick another one.',
  mailboxTaken: 'Another member already uses this handle as an email address. Pick another one.',
  working: 'They are working now ({work}). You can rename them when they are done.',
  former: 'formerly:',
} as const;
