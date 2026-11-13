export const pm = {
  relayed: 'from their conversation',
  /** The pm is a member of the Messages page like any other; this is its chip there (PM-447). */
  distributor: 'distributor',
  distributorTitle: 'They hand out the day-to-day work themselves.',
  emptyThread:
    'The Project manager hands out the work. The connected Claude takes care of your day-to-day requests.',
  required: {
    chip: 'required',
    title: 'The project always needs an AI Project manager.',
    retireNote:
      'They are the project’s only AI Project manager. Hire another one first, then you can retire them.',
  },
} as const;
