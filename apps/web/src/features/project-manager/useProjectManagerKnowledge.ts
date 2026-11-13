import { useQuery } from '@tanstack/react-query';
import { canReadProjectManagerKnowledge } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';

export function useProjectManagerKnowledge() {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const readable = !me.via && canReadProjectManagerKnowledge({ access });
  const knowledge = useQuery({
    queryKey: queryKeys.projectManagerKnowledge(key),
    queryFn: () => api.projectManagerKnowledge(key),
    enabled: readable,
  });
  const preference = useQuery({
    queryKey: queryKeys.projectManagerPreferenceMe(key, myHandle),
    queryFn: () => api.projectManagerPreferenceMe(key),
    enabled: myHandle !== null && !me.via,
  });
  const preferences = useQuery({
    queryKey: queryKeys.projectManagerPreferences(key),
    queryFn: () => api.projectManagerPreferences(key),
    enabled: readable,
  });
  return { knowledge, preference, preferences, readable };
}
