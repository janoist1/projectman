/** A card held at its fix round limit (PM-262): the lead developer, then the people decide. */
export const fixLimit = {
  box: {
    integrator: 'it is up to the connected Claude',
    extras: 'Extra rounds: {used} of 3 used.',
    extrasOver: 'Extra rounds: {used} used, more than the limit of 3.',
    title: 'Stopped at the fix round limit',
    count: '{rounds} / {limit}',
    text: 'After {parts}, the card no longer goes back to the developer by itself.',
    lead: '{name} decides whether it can go on.',
    replan: '{name} writes a more detailed plan, then it goes on.',
    people: {
      no_ai_decider: 'There is no AI lead developer, so {decides}.',
      decider_timeout: 'The AI decider didn’t decide in time, so {decides}.',
      passed_on: 'The lead developer passed it on, so {decides}.',
      again: 'It hit the limit again after one more round, so {decides}.',
      extra_exhausted: 'The 3 extra rounds are used up and it hit the limit again, so {decides}.',
    },
  },
  /** The rounds a count is made of; only the ones that are not zero are named. */
  part: {
    changes: '{count|# code review|# code reviews}',
    design: '{count|# UI/UX review|# UI/UX reviews}',
    sendBacks: '{count|# send-back|# send-backs}',
    manual: '{count|# manual send-back|# manual send-backs}',
    testsFailed: '{count|# failed full test|# failed full tests}',
  },
  decisions: {
    continue: 'one more round',
    another_round: 'one more round',
    replan: 'a more detailed plan',
    reassign: 'another developer takes it',
  },
  endReasons: {
    decided: 'a decision was made',
    assignee_changed: 'another developer took it',
    closed: 'the card was closed',
  },
  events: {
    reached: 'The card reached the fix round limit: {rounds|# round|# rounds} ({parts}); {who}.',
    reachedLimit:
      'The card reached the fix round limit: {rounds|# round|# rounds}, limit {limit} ({parts}); {who}.',
    who: '{name} decides',
    people: '{decides}',
    passed_on: 'Passed the decision on: {decides}.{note}',
    decided: 'Decided: {decision}.{note}',
    decidedExtra: 'Decided: one more round (extra round {i} of 3).{note}',
    assessment: ' Recurring: {recurrence} Now: {currentState} Suggested: {decision}. {reason}',
    notCounted: 'Does not count as a fix round.',
    ended: 'The fix round limit no longer holds the card back: {reason}.',
    note: ' Reason: “{note}”',
  },
} as const;
