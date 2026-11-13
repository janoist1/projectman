export const templates = {
  starter: {
    name: 'Starter team',
    description: 'One developer and a project manager, with a simple board.',
  },
  'web-client-project': {
    name: 'Client development',
    description: 'Development, review, testing, client testing and release. You decide on the release.',
  },
  'small-team': {
    name: 'Small team',
    description: 'One developer and one reviewer. You decide when to close.',
  },
  'internal-tool': {
    name: 'Internal tool',
    description: 'Development, review and testing, without client testing. You decide on the merge.',
  },
  'daily-routine': {
    name: 'Daily routine',
    description: 'A colleague reviews the code on weekday mornings and opens cards for findings.',
  },
} as const;
