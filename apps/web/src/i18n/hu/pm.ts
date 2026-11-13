/** What stays of the project manager's header panel (PM-429): the relayed mark and the required chip. */
export const pm = {
  relayed: 'a beszélgetéséből',
  /** The pm is a member of the Messages page like any other; this is its chip there (PM-447). */
  distributor: 'elosztó',
  distributorTitle: 'Ő osztja el magától a napi munkát.',
  emptyThread: 'A Projektmenedzser osztja a munkát. A napi kéréseidet a csatlakoztatott Claude intézi.',
  required: {
    chip: 'kötelező',
    title: 'A projektben mindig kell egy AI Projektmenedzser.',
    retireNote:
      'Ő a projekt egyetlen AI Projektmenedzsere. Előbb vegyél fel egy másikat, utána elbocsáthatod.',
  },
} as const;
