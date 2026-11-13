export const integratorKey = {
  title: 'Claude Code on your machine',
  audit: 'Activity log',
  auditEmpty: 'No entries yet.',
  auditActions: { created: 'Created', revoked: 'Revoked' },
  modes: { super: 'Full permissions', read: 'Read-only', legacy: 'Legacy key' },
  purpose: 'What is it for?',
  superHint: 'For the connected Claude (Claude Code): it works in your name and with your rights.',
  readHint: 'For scripts: reading and following events; it cannot change anything.',
  days1: '1 day',
  days7: '7 days',
  days365: '365 days',
  noExpiryHint: 'A leaked key stays valid until it is revoked. You can revoke it at any time.',
  readSecretTitle: 'New read key',
  superSecretTitle: 'New Claude Code key',
  emptyHint: 'Without a key, Claude Code can’t connect. The team works without it too.',
  past: 'Earlier keys ({n})',
  ownerOnly: 'Only the owner can manage the keys, with their own login.',
  today:
    'The Claude Code key expires today. Add a new one in time, otherwise Claude Code’s calls will be refused.',
  channels: { mcp: 'MCP', cli: 'command line', rest: 'API' },
  connection: 'Connecting',
  connectionBody:
    'Save the key to the ~/.config/projectman/integrator-key file (folder: 700, file: 600). The projectman command reads from this file. In the cloud, the Access service token is needed too, in the same folder. Never pass the key as a command-line argument. Details: docs/DEPLOY.md.',
  mcpAddress: 'MCP address',
  /** The instruction for the owner’s own assistant (PM-1078): it names no key; the owner saves it from the clipboard. */
  assistant: {
    summary: 'With an AI assistant',
    intro:
      'Paste it into the Claude or Codex desktop app. If it asks for the key, put it on the clipboard with the Copy button above; it isn’t in the instruction.',
    introOpen:
      'Paste it into the Claude or Codex desktop app. There is no key in the instruction: if it asks for it, put the key on the clipboard with the Copy button when you create it.',
    aria: 'Instruction for the assistant',
    copy: 'Copy instruction',
    help: 'The assistant runs commands on your machine, with your permission.',
    helpOwner: 'The key only gives access to your own projects.',
    head: 'Help me connect you to projectman ({origin}) on this machine, over MCP. Go step by step, tell me what each command does before you run it, and if something fails, stop and tell me what happened.',
    install:
      'If there’s no projectman folder on this machine yet (for example from setting up my machine), download it: `git clone https://github.com/janoist1/projectman.git ~/projectman && cd ~/projectman && npm install`. Then run `npm link` in the folder so the `projectman` command is available.',
    saveKey:
      'Create the `~/.config/projectman` folder with mode 700. Ask me to copy the key from the projectman page, and once I tell you I have, save it: `pbpaste > ~/.config/projectman/integrator-key && chmod 600 ~/.config/projectman/integrator-key` (outside macOS, use the system’s clipboard command). Don’t print the key, don’t read it back, and don’t ask me to type it into the conversation.',
    cloudToken:
      'Check whether `~/.config/projectman/cloud/integrator-access-token.json` exists (mode 600). I get it in person from the host of projectman. If it’s missing, ask me to create it; don’t ask for its values.',
    client:
      'Write `~/.config/projectman/client.json` with mode 600: `baseUrl` = `{origin}`, `keyFile` = `~/.config/projectman/integrator-key`{cloudFile}, `version` = 1. No secrets go into it.',
    clientCloudFile: ', `accessHeadersFile` = `~/.config/projectman/cloud/integrator-access-token.json`',
    mcp: 'Add the projectman server to your own MCP settings: command `projectman`, argument `mcp-proxy`. (The proxy calls {mcpUrl}.) No secrets go here either.',
    verify:
      'Ask me to restart the app, then call projectman’s`list_projects` tool and tell me which projects you can see.',
    tail: 'Never ask me for a password, key or token, and never write one to a file or a message; I do the logins myself.',
  },
  revokeReadBody:
    'Every call from the scripts is refused immediately. What they did so far stays in the log.',
  intro:
    'If you use Claude Code, this key makes it your connected Claude: it reaches the actions in your name and with your rights, logged. The queue keeps moving without it.',
  none: 'No key yet.',
  noValid: 'No valid key.',
  create: 'Create key',
  submit: 'Create',
  new: 'New key',
  revoked: 'The key was revoked.',
  copyFailed: 'Couldn’t copy. Select the key and copy it yourself.',
  revoke: 'Revoke',
  expiry: 'Expiry',
  days30: '30 days',
  days90: '90 days',
  never: 'Never expires',
  once: 'You only see this now. Save it to the ~/.config/projectman/integrator-key file. Don’t send it in a message, don’t put it on a card, and don’t pass it as a command-line argument.',
  copy: 'Copy',
  copied: 'Copied',
  done: 'Done, I’ve saved it',
  prefix: 'Key',
  created: 'Created',
  used: 'Last used',
  expires: 'Expires',
  soon: 'The Claude Code key expires in {n|# day|# days}. Add a new one in time, otherwise Claude Code’s calls will be refused.',
  replaceBody:
    'The current Claude Code key ({prefix}…) stops working immediately; Claude Code carries on with the new one.',
  replaceReadBody:
    'The current read key ({prefix}…) stops working immediately; the scripts carry on with the new one.',
  revokeTitle: 'Revoke the {prefix}… key?',
  revokeBody:
    'Every call from Claude Code is refused immediately: over MCP, on the command line and on the event stream. What it did so far stays, under the connected Claude’s name.',
  states: { active: 'Active', expired: 'Expired', revoked: 'Revoked' },
  error: 'Couldn’t load the keys.',
  activity: 'What did it do with this key?',
  forwarded: 'The owner’s answer, recorded by the connected Claude',
} as const;
