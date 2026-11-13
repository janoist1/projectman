export const boundary = {
  heading: 'Külső művelet engedélyezése',
  categories: {
    cost: 'Költség: tulajdonosi döntés',
    production: 'Éles rendszer vagy publikálás: tulajdonosi döntés',
    credentials: 'Új hozzáférés vagy titok: tulajdonosi döntés',
    host_expansion: 'Tartós határtágítás: tulajdonosi döntés',
  },
  states: {
    pending_lead: 'Vezetőre vár',
    pending_owner: 'Tulajdonosra vár',
    allowed: 'Engedélyezve',
    denied: 'Elutasítva',
    expired: 'Lejárt',
    revoked: 'Visszavonva',
  },
  reasons: {
    scope_verified: 'A célt és a hatókört ellenőriztem',
    unsafe_target: 'A cél nem biztonságos',
    insufficient_context: 'Nincs elég információ',
    not_needed: 'A műveletre nincs szükség',
    owner_revoked: 'A tulajdonos visszavonta',
    deadline_expired: 'Lejárt az érvényessége',
    policy_changed: 'Megváltoztak a szabályok vagy a hozzáférés',
    lead_unavailable: 'A vezető nem döntött időben vagy nem elérhető',
  },
} as const;
