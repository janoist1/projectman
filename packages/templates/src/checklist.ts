import type { ChecklistCondition } from '@projectman/shared';

export const BASE_CHECKLIST: readonly { id: string; condition: ChecklistCondition | null }[] = [
  { id: 'goal', condition: null },
  { id: 'code', condition: null },
  { id: 'providers', condition: null },
  { id: 'team', condition: null },
  { id: 'process', condition: null },
  { id: 'labels', condition: null },
  { id: 'clients', condition: null },
  { id: 'release', condition: null },
  { id: 'agreement', condition: 'agreement_approved' },
  { id: 'first_task', condition: 'task_exists' },
];
