import { useQuery } from '@tanstack/react-query';
import { canReadOperatorKnowledge } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';

export function useOperatorKnowledge() {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const readable = !me.via && canReadOperatorKnowledge({ access });
  const knowledge = useQuery({
    queryKey: queryKeys.operatorKnowledge(key),
    queryFn: () => api.operatorKnowledge(key),
    enabled: readable,
  });
  const preference = useQuery({
    queryKey: queryKeys.operatorPreferenceMe(key, myHandle),
    queryFn: () => api.operatorPreferenceMe(key),
    enabled: myHandle !== null && !me.via,
  });
  const preferences = useQuery({
    queryKey: queryKeys.operatorPreferences(key),
    queryFn: () => api.operatorPreferences(key),
    enabled: readable,
  });
  return { knowledge, preference, preferences, readable };
}
