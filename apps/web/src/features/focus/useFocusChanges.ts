import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';

/** The latest changes of the project's focus, newest first (the panel's "Változások"). */
export function useFocusChanges(enabled: boolean) {
  const { key } = useProject();
  return useQuery({
    queryKey: queryKeys.focusChanges(key),
    queryFn: () => api.projectFocusChanges(key),
    enabled,
  });
}
