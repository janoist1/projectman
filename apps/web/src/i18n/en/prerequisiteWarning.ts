export const prerequisiteWarning = {
  title: 'The prerequisite is still open',
  description: 'This card is waiting for {keys}. Starting now begins work before the prerequisite closes.',
  groupDescription:
    'These cards are waiting for prerequisites. Starting now begins work before the prerequisites close.',
  groupRow: '{key}: {keys}',
  confirm: 'Start anyway',
  moveAndWait: 'Move and wait',
} as const;
