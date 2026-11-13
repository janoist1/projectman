/** A card held at its fix round limit (PM-262): the lead developer, then the people decide. */
export const fixLimit = {
  box: {
    integrator: 'a csatlakoztatott Claude dönt',
    extras: 'Extra kör: {used} kiadva a 3-ból.',
    extrasOver: 'Extra kör: {used} kiadva, több a 3-as határnál.',
    title: 'Megállt a javítási körök határánál',
    count: '{rounds} / {limit}',
    text: '{parts} után nem megy vissza magától a fejlesztőhöz.',
    lead: '{name} dönt, hogy mehet-e tovább.',
    replan: '{name} pontosabb tervet ír, utána megy tovább.',
    people: {
      no_ai_decider: 'Nincs AI vezető fejlesztő, ezért {decides} róla.',
      decider_timeout: 'Az AI döntő nem döntött határidőn belül, ezért {decides} róla.',
      passed_on: 'A vezető fejlesztő továbbadta, ezért {decides} róla.',
      again: 'Még egy kör után újra elérte a határt, ezért {decides} róla.',
      extra_exhausted: 'A 3 extra kör elfogyott, és újra elérte a határt, ezért {decides} róla.',
    },
  },
  /** The rounds a count is made of; only the ones that are not zero are named. */
  part: {
    changes: '{count} kódátnézés',
    design: '{count} UI/UX átnézés',
    sendBacks: '{count} visszaküldés',
    manual: '{count} kézi visszaküldés',
    testsFailed: '{count} bukott teljes teszt',
  },
  decisions: {
    continue: 'még egy kör',
    another_round: 'még egy kör',
    replan: 'pontosabb terv',
    reassign: 'más fejlesztő viszi',
  },
  endReasons: {
    decided: 'döntés született',
    assignee_changed: 'más fejlesztő kapta',
    closed: 'a kártya lezárult',
  },
  events: {
    reached: 'A kártya elérte a javítási körök határát: {rounds} kör ({parts}); {who}.',
    reachedLimit: 'A kártya elérte a javítási körök határát: {rounds} kör, a határ {limit} ({parts}); {who}.',
    who: '{name} dönt',
    people: '{decides}',
    passed_on: 'Továbbadta a döntést: {decides}.{note}',
    decided: 'Döntött: {decision}.{note}',
    decidedExtra: 'Döntött: még egy kör ({i}/3 extra kör).{note}',
    assessment: ' Ismétlődik: {recurrence} Most: {currentState} Javasolja: {decision}. {reason}',
    notCounted: 'Nem számít javítási körnek.',
    ended: 'A javítási körök határa nem tartja vissza többé: {reason}.',
    note: ' Indoka: „{note}”',
  },
} as const;
