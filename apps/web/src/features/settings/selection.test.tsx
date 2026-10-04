import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLocation, useNavigate } from 'react-router';
import { renderUi } from '../../test/render';
import { parseShow, showParams, useSettingsSelection } from './selection';
import type { SettingsShow } from './selection';

describe('settings URL selection', () => {
  it.each<SettingsShow>([
    { type: 'stage', id: 'dev' },
    { type: 'column', id: 'work' },
    { type: 'label', id: 'qa-ok' },
    { type: 'new-stage' },
    { type: 'new-stage', after: 'dev' },
    { type: 'new-column' },
    { type: 'new-label' },
  ])('round trips $type', (show) => {
    expect(parseShow(showParams(show, 'how-we-work'))).toEqual(show);
    expect(showParams(show, 'how-we-work').get('from')).toBe('how-we-work');
  });
  it.each(['', 'stage:', 'stage:a:b', 'stage', 'unknown:dev', 'new-stage:dev'])(
    'rejects invalid selection %s',
    (show) => {
      expect(parseShow(new URLSearchParams({ show }))).toBeNull();
    },
  );
  it('clears origin when no item is selected', () => {
    expect(showParams(null, 'how-we-work').toString()).toBe('');
  });
  function Controls() {
    const selection = useSettingsSelection();
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <>
        <output>
          {location.pathname}
          {location.search}
        </output>
        <button onClick={() => selection.open({ type: 'stage', id: 'dev' })}>Open</button>
        <button onClick={selection.close}>Close</button>
        <button onClick={() => navigate(-1)}>Back</button>
        <button onClick={() => navigate('/settings/pipeline')}>Enter</button>
      </>
    );
  }
  it('pushes open, so Back closes, and close consumes its own entry', () => {
    renderUi(<Controls />, { route: '/previous' });
    fireEvent.click(screen.getByText('Enter'));
    fireEvent.click(screen.getByText('Open'));
    expect(screen.getByRole('status').textContent).toContain('?show=stage%3Adev');
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByRole('status').textContent).toBe('/settings/pipeline');
    fireEvent.click(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Close'));
    expect(screen.getByRole('status').textContent).toBe('/settings/pipeline');
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByRole('status').textContent).toBe('/previous');
  });
  it('replaces a direct link and removes from and after', () => {
    renderUi(<Controls />, { route: '/settings/pipeline?show=new-stage&after=dev&from=how-we-work&keep=1' });
    fireEvent.click(screen.getByText('Close'));
    expect(screen.getByRole('status').textContent).toBe('/settings/pipeline?keep=1');
  });
});
