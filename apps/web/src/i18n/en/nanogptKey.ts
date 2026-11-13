export const nanogptKey = {
  title: 'Enter a NanoGPT key',
  replaceTitle: 'Replace the NanoGPT key',
  replaceDescription:
    'Running sessions carry on with the old key; they get the new one when they next start.',
  field: 'API key',
  hint: 'You find it in your nano-gpt.com account, under API keys. After saving it is not shown, only replaced or deleted. Only the sessions of NanoGPT members get it.',
  required: 'Enter the key.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'NanoGPT key saved.',
  replaced: 'NanoGPT key replaced.',
  deleted: 'NanoGPT key deleted.',
  add: 'Enter a key',
  replace: 'Replace',
  delete: 'Delete',
  deleting: 'Deleting…',
  replaceLabel: 'Replace the NanoGPT key',
  deleteLabel: 'Delete the NanoGPT key',
  deleteTitle: 'Delete the NanoGPT key?',
  deleteDescription:
    'New sessions of NanoGPT members won’t start until you enter a new key. Sessions that are already running won’t stop.',
} as const;
