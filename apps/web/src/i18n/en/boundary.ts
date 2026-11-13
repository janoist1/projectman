export const boundary = {
  heading: 'Approve an outside action',
  categories: {
    cost: 'Cost: owner decision',
    production: 'Production system or publishing: owner decision',
    credentials: 'New access or secret: owner decision',
    host_expansion: 'Lasting boundary extension: owner decision',
  },
  states: {
    pending_lead: 'Waiting for the lead',
    pending_owner: 'Waiting for the owner',
    allowed: 'Allowed',
    denied: 'Denied',
    expired: 'Expired',
    revoked: 'Revoked',
  },
  reasons: {
    scope_verified: 'I checked the target and the scope',
    unsafe_target: 'The target is not safe',
    insufficient_context: 'Not enough information',
    not_needed: 'The action isn’t needed',
    owner_revoked: 'The owner revoked it',
    deadline_expired: 'Its validity expired',
    policy_changed: 'The rules or the access changed',
    lead_unavailable: 'The lead didn’t decide in time or isn’t available',
  },
} as const;
