import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from './client';
import { mockProject } from '../test/mockProject';
import { useBoard } from './queries';

function BoardProbe() {
  const board = useBoard('AC');
  return <output>{board.data?.project.name}</output>;
}

afterEach(() => {
  vi.useRealTimers();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('board usage subscription', () => {
  it('does not refetch the board on a 60-second usage interval', async () => {
    const project = mockProject();
    project.render(<BoardProbe />);
    await screen.findByText('Acme webshop');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(project.requests.filter((request) => request.path.endsWith('/board'))).toHaveLength(1);
  });
});
