import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderUi } from '../../test/render';
import { t } from '../../i18n/t';
import { DetailPanel } from './DetailPanel';

afterEach(() => vi.restoreAllMocks());
function Fixture() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('First');
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button onClick={() => setTitle('Second')}>Switch</button>
      <DetailPanel
        open={open}
        title={title}
        kicker="Stage"
        footer={<button>Save</button>}
        empty="Choose an item"
        onClose={() => setOpen(false)}
      >
        <input aria-label="Name" />
      </DetailPanel>
    </>
  );
}
describe('settings detail panel', () => {
  it.each([false, true])('focuses the title and restores the opener (wide=%s)', (wide) => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: wide,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      onchange: null,
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    renderUi(<Fixture />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const heading = screen.getByRole('heading', { name: 'First' });
    expect(document.activeElement).toBe(heading);
    expect(wide ? screen.getByRole('complementary') : screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('Switch'));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Second' }));
    fireEvent.click(screen.getByRole('button', { name: t('common.close') }));
    expect(document.activeElement).toBe(opener);
    expect(screen.queryByRole('heading', { name: 'Second' })).toBeNull();
  });
  it('closes with Escape only inside the wide panel', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      onchange: null,
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    renderUi(<Fixture />);
    fireEvent.click(screen.getByText('Open'));
    fireEvent.keyDown(screen.getByText('Open'), { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('heading', { name: 'First' }), { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'First' })).toBeNull();
  });
});
