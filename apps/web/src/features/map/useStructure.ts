import { useQuery } from '@tanstack/react-query';
import type { StructureView } from '@projectman/shared';
import { apiRequest } from '../../api/client';

export function useStructure(projectKey: string) {
  return useQuery({
    queryKey: ['structure', projectKey],
    queryFn: ({ signal }) =>
      apiRequest<StructureView>(`/api/projects/${encodeURIComponent(projectKey)}/structure`, { signal }),
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}
