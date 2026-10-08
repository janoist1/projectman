import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { MapGroup } from '@projectman/shared';
import { t } from '../../i18n/t';
import { indexPipeline } from '../../lib/pipeline';
import { GroupTile } from './GroupTile';

const pipeline = indexPipeline({
  columns: [{ id: 'finished', name: 'Finished', stageIds: ['done'] }],
  stages: [],
});

function renderTile(overrides: Partial<MapGroup>) {
  const group: MapGroup = {
    kind: 'theme',
    key: 'AC-5',
    cardKeys: [],
    lanes: [],
    signals: { needsYou: 0, blocked: 0, working: 0, waiting: 0, open: 0 },
    progress: { done: 0, total: 0, byStage: {} },
    ...overrides,
  };
  render(
    <MemoryRouter>
      <ul>
        <GroupTile
          group={group}
          title="Checkout"
          base="/p/AC/map"
          pipeline={pipeline}
          flash={false}
          itemRef={() => {}}
        />
      </ul>
    </MemoryRouter>,
  );
}

describe('a group tile with nothing that needs a look', () => {
  it('says that everything is done when every card is', () => {
    renderTile({ progress: { done: 3, total: 3, byStage: { done: 3 } } });
    expect(screen.getByText(t('map.allDone'))).toBeTruthy();
    expect(screen.getByText(t('map.progress', { done: 3, total: 3 }))).toBeTruthy();
  });

  it('says that the group has no cards', () => {
    renderTile({});
    expect(screen.getByText(t('map.signals.noCards'))).toBeTruthy();
  });

  it('says that nothing is open when some cards are done and the rest are not waiting', () => {
    renderTile({ progress: { done: 1, total: 3, byStage: { done: 1 } } });
    expect(screen.getByText(t('map.signals.noneOpen'))).toBeTruthy();
  });

  it('names who the group waits for in the quiet case', () => {
    renderTile({
      signals: { needsYou: 0, blocked: 0, working: 0, waiting: 2, open: 2 },
      progress: { done: 0, total: 2, byStage: {} },
    });
    expect(screen.getByText(t('map.signals.waiting', { count: 2 }))).toBeTruthy();
    expect(screen.queryByText(t('map.allDone'))).toBeNull();
  });
});
