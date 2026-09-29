import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { routes, ScheduleRun, SchedulesView } from '@projectman/shared';
import { queryKeys } from './queryKeys';
import { apiRequest } from './client';

const schedulesKey = (key: string) => ['project', key, 'schedules'] as const;
export function useSchedules(key: string, enabled = true) {
  return useQuery({
    queryKey: schedulesKey(key),
    queryFn: () => apiRequest(routes.schedules(key), { schema: SchedulesView }),
    refetchInterval: 60_000,
    enabled,
  });
}
export function useRunSchedule(key: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) =>
      apiRequest(routes.runSchedule(key, handle), { method: 'POST', schema: ScheduleRun }),
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: schedulesKey(key) }),
        client.invalidateQueries({ queryKey: queryKeys.board(key) }),
        client.invalidateQueries({ queryKey: queryKeys.members(key) }),
      ]);
    },
  });
}
