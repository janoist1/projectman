export const cardBusyWarning = {
  titleWorking: 'Someone is already working on this card',
  titleJoining: 'This message would send several members to the same work',
  description:
    '{taskKey}: members with the same role would work on it at the same time. Send anyway if the collaboration is intentional; otherwise go back and change the recipients.',
  working: 'Already working on it',
  joining: 'The message would send',
  joiningMark: 'would join now',
  back: 'Back',
  confirm: 'Send anyway',
} as const;
