import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';

/**
 * The owner's weekly question measure (PM-1192): loaded when its view opens and on "Frissítés" only, never by
 * polling, a window focus or a reconnect; nothing is kept once the view closes.
 */
export function useOwnerQuestions(key: string) {
  return useQuery({
    queryKey: queryKeys.ownerQuestions(key),
    queryFn: () => api.ownerQuestions(key),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
