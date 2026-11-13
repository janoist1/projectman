export const permissionControls = {
  nanogptApproverNone:
    'For a NanoGPT member, only a person can approve commands outside the sandbox (for example commit, npm ci). With “Nobody” these are refused, so as a developer the member can’t commit.',
  mode: 'Mode',
  providerNotes: {
    gemini: {
      auto: 'For a Gemini member, Auto works like “Accept edits”: it asks about every command outside the duty’s allowed commands, and the “Who decides when it asks” setting decides it.',
      plan: 'For a Gemini member, Plan mode only blocks file edits: the pre-approved commands of the duties that work in the worktree (for example git commit, npm install) run without a sandbox.',
    },
  },
  approver: 'Who decides when it asks',
  approvers: {
    human: 'A person',
    ai: 'AI decider',
    none: 'Nobody',
  },
  legacy: 'old setting',
  legacyHint: 'The old “everything allowed” setting. Choosing a new mode replaces it.',
  network: 'Outbound network',
  networkHints: {
    on: 'Their commands can reach any address except the live instance’s.',
    off: 'Only npm is reachable. For any other address it asks for permission, as the “Who decides when it asks” setting says.',
    offRefused: 'Only npm is reachable. Any other address is refused.',
  },
  networkValues: {
    on: 'on',
    off: 'off',
  },
  networkFacts: {
    on: 'On',
  },
  networkState: 'Outbound network: {value}',
  savedNetwork: '{name}’s outbound network: {value}. It applies from the next session.',
  blocked: {
    delegation_off: 'Not available: delegating permission requests is switched off.',
    no_ai_decider: 'Not available: there is no AI member who could decide on permission requests.',
  },
  lostApprover: 'There is no AI decider, so the questions go to a person: {names}.',
  lostApproverLabel: 'Decider warning',
  savedMode: '{name}’s mode: {value}.',
  savedApprover: '{name}’s decider: {value}.',
} as const;
