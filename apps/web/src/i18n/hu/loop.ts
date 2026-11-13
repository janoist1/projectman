/** A loop on a card (PM-261): AI members writing to each other without progress. */
export const loop = {
  mark: 'Körbe fut',
  /** Stands for the member who holds the Ütemezés duty when the payload names none. */
  schedulingHolder: 'Az Ütemezés felelőse',
  decides: '{names} dönt',
  youDecide: 'te döntesz',
  summary: '{pair} {minutes} perce ír egymásnak haladás nélkül ({count} üzenet). {who}',
  who: {
    notified: 'Jelezve: {name}.',
    no_watcher: 'Az Ütemezést senki nem tölti be, ezért {decides} róla.',
    continued: '{name} jelzése után is folytatódott, ezért {decides} róla.',
    let_run: '{name}: hadd fusson.',
  },
  box: {
    title: 'Körbe fut a beszélgetés',
    text: '{pair} {count} üzenetet váltott, közben nem volt commit, lépés- vagy címkeváltás, leírás-módosítás, csatolmány vagy jegyzet.',
    let_run: '{name} úgy döntött, hadd fusson. A jelölés eltűnik, ha elcsitul.',
    messages: 'Üzenetek',
  },
  events: {
    raised: 'Körbeírogatás: {pair} {minutes} perc alatt {count} üzenet, haladás nélkül. Jelezve: {name}.',
    raisedToPeople: 'Körbeírogatás: {pair} {minutes} perc alatt {count} üzenet, haladás nélkül.',
    escalated: {
      continued: 'A jelzés után is folytatódott; {decides}.',
      no_watcher: 'Az Ütemezést senki nem tölti be; {decides}.',
    },
    let_run: '{name}: hadd fusson.',
    ended: 'A körbeírogatás véget ért: {reason}.',
  },
  endReasons: {
    label: 'címkeváltás',
    stage: 'lépésváltás',
    commit: 'commit',
    work: 'a leírás, egy csatolmány vagy egy jegyzet haladást hozott',
    quiet: 'elcsitult',
    stopped: 'leállítva',
    let_run: 'hadd fusson',
    disabled: 'kikapcsolva',
    closed: 'a kártya lezárult',
  },
} as const;
