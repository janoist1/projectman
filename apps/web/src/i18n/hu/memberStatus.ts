export const memberStatus = {
  no_account: 'Nincs még fiókja',
  idle: 'Pihen',
  working: 'Dolgozik',
  waiting_for_human: 'Emberre vár',
  online: 'Online',
  offline: 'Nincs bent',
  invited: 'Meghívva',
  retired: 'Elbocsátva',
  needsYou: 'Rád vár',
  paused: 'Szünetel',
  pausing: 'Megáll…',
  /** An outage keeps the member from working (PM-468); the reason follows (`inbox.alerts.work_outage.reasons`). */
  cannotWork: 'Nem tud dolgozni',
  cannotWorkWithReason: 'Nem tud dolgozni: {reason}',
  /** The bold lead of the phone card's line; the reason follows it in the normal weight. */
  cannotWorkLead: 'Nem tud dolgozni:',
  quotaReason: 'Elfogyott a szolgáltatói kerete; a visszaállásra vár.',
  quotaReasonUntil: 'Elfogyott a szolgáltatói kerete; kb. {time}-kor áll vissza.',
} as const;
