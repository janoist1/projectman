import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { mockIndexes, renderUi } from '../test/render';
import { StageProgress } from './StageProgress';

const { pipeline } = mockIndexes();

function renderStepper(stageId: string) {
  renderUi(<StageProgress pipeline={pipeline} stageId={stageId} phase="working" variant="stepper" />);
}

/** The step of a board column, found by the column name it shows. */
const step = (columnName: string) => screen.getByText(columnName, { exact: false }).closest('li')!;

const stepList = (columnName: string) =>
  screen.queryByRole('list', { name: t('taskCard.columnSteps', { column: columnName }) });

describe('StageProgress stepper', () => {
  it('lists the steps of the column on hover, marking done, current and pending ones', () => {
    renderStepper('integration');
    expect(stepList('Átnézés')).toBeNull();

    fireEvent.mouseEnter(step('Átnézés'));
    const items = within(stepList('Átnézés')!).getAllByRole('listitem');
    expect(items.map((item) => item.dataset.state)).toEqual(['done', 'current', 'todo']);
    expect(within(items[1]!).getByText(t('taskCard.stepState.current'))).toBeTruthy();

    fireEvent.mouseLeave(step('Átnézés'));
    expect(stepList('Átnézés')).toBeNull();
  });

  it('opens on keyboard focus, closes on blur and on Escape', () => {
    renderStepper('integration');
    const review = step('Átnézés');
    expect(review.tabIndex).toBe(0);

    fireEvent.focus(review);
    expect(stepList('Átnézés')).not.toBeNull();
    fireEvent.blur(review);
    expect(stepList('Átnézés')).toBeNull();

    fireEvent.focus(review);
    fireEvent.keyDown(review, { key: 'Escape' });
    expect(stepList('Átnézés')).toBeNull();
  });

  it('works for a multi-step column that is not the current one, and not for a single-step one', () => {
    renderStepper('dev');
    const multi = pipeline.columns.find(
      (column) =>
        pipeline.stages.filter((s) => pipeline.columnOfStage.get(s.id)?.id === column.id).length > 1,
    )!;
    const single = pipeline.columns.find((column) => column.id === 'dev')!;

    fireEvent.mouseEnter(step(multi.name));
    const items = within(stepList(multi.name)!).getAllByRole('listitem');
    expect(items.every((item) => item.dataset.state === 'todo')).toBe(true);

    expect(step(single.name).tabIndex).toBe(-1);
    fireEvent.mouseEnter(step(single.name));
    expect(stepList(single.name)).toBeNull();
  });
});
