/** Device pairing of a friend's machine (PM-1437, PM-1450): the page the machine's code leads to. */
export const pairing = {
  enter: {
    title: 'Pair a machine',
    subtitle: 'Enter the code the installation printed on your machine.',
    label: 'Code',
    hint: '8 letters, for example WDJB-MJHT. You don’t need to type the hyphen.',
    submit: 'Continue',
    invalid:
      'This code isn’t valid. You may have mistyped it, or it has expired or already been used. Check the machine again, or ask the installer for a new code.',
    tooMany: 'Too many wrong codes. Try again in {time}.',
    wait: 'Try again in {time}',
    announceReady: 'You can try again.',
  },
  loading: 'Checking the code…',
  approve: {
    title: 'Approve this machine?',
    subtitle: 'A machine is asking for access to your account so it can work on your projects.',
    sameCode: 'Is this the same code you see on the machine?',
    machine: 'Machine',
    requested: 'Requested',
    requestedValue: '{time} ({ago})',
    validFor: 'Still valid for',
    oneMinute: 'Valid for 1 more minute.',
    creates: 'Approving creates',
    createsEngine: '{name} among Your machines',
    createsEngineNote: 'In your name; your projects’ AI members work on it.',
    createsKey: 'A Claude Code key with full permissions',
    createsKeyNote: 'It only reaches your own projects and can’t publish a release. Expires: {date}.',
    replaces:
      'Your current Claude Code key ({prefix}…) stops working; the connected Claude carries on with the new one.',
    keysNote: 'The machine receives the keys directly; you never see them.',
    warning:
      'Approve only if you started the installation yourself, on your own machine. If someone asks you in a message to approve a code, decline.',
    approve: 'Approve',
    approving: 'Approving…',
    deny: 'Decline',
    denying: 'Declining…',
    footnote: 'You can revoke the machine and the key later in Settings.',
    approveFailed: 'Couldn’t approve. Try again. The machine waits meanwhile.',
    denyFailed: 'Couldn’t decline. Try again.',
    tooMany: 'Too many attempts. Try again in {time}.',
  },
  done: {
    title: 'Machine paired',
    subtitle: '{name} has received its keys. The installation carries on by itself on the machine.',
    body: 'Go back to the installer AI; it takes you on from here: connecting the project and the check come next.',
    open: 'Open Your machines',
  },
  denied: {
    title: 'Declined',
    subtitle: 'The machine got no access. The installation on the machine stops and writes nothing to it.',
    body: 'If you did start it: ask the installer for a new code and approve that one.',
  },
  expired: {
    title: 'The code expired',
    subtitle:
      'A code is valid for 10 minutes. The installation on the machine stops and writes nothing to it.',
    body: 'Ask the installer for a new code and open the new link.',
    again: 'Enter another code',
  },
  noRight: {
    title: 'You can’t approve with this account',
    subtitle: 'Only an owner account can create a machine and a Claude Code key. The machine got nothing.',
    body: 'Log in with the account you manage your projects with, and open the link again.',
    login: 'Log in with another account',
    loggingOut: 'Logging out…',
  },
  /** The ending of a machine's or a key's line when it came from a pairing. */
  paired: ', paired',
  /** The button in Settings → Engines. */
  withCode: 'Pair with a code',
} as const;
