import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderUi } from '../../test/render';
import { t } from '../../i18n/t';
import { DetailPanel } from './DetailPanel';
import { MoreMenu } from '../../components/MoreMenu';

afterEach(() => vi.restoreAllMocks());
function Fixture() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('First');
  const [itemKey, setItemKey] = useState('first');
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button
        onClick={() => {
          setTitle('Second');
          setItemKey('second');
        }}
      >
        Switch
      </button>
      <DetailPanel
        open={open}
        title={title}
        itemKey={itemKey}
        kicker="Stage"
        menu={<MoreMenu>{() => <button>Menu action</button>}</MoreMenu>}
        footer={<button>Save</button>}
        empty="Choose an item"
        onClose={() => setOpen(false)}
      >
        <input aria-label="Name" value={title} onChange={(event) => setTitle(event.target.value)} />
      </DetailPanel>
    </>
  );
}
describe('settings detail panel', () => {
  it.each([false, true])('dismisses the real menu before the panel with Escape (wide=%s)', (wide) => {
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
    const trigger = screen.getByRole('button', { name: t('common.moreActions') });
    for (const focusAction of [false, true]) {
      fireEvent.click(trigger);
      const action = screen.getByText('Menu action');
      const target = focusAction ? action : trigger;
      target.focus();
      expect(fireEvent.keyDown(target, { key: 'Escape' })).toBe(wide);
      expect(screen.queryByText('Menu action')).toBeNull();
      expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy();
      expect(document.activeElement).toBe(trigger);
    }
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'First' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('dismisses the real menu before the panel on native dialog cancel', () => {
    renderUi(<Fixture />);
    const opener = screen.getByText('Open');
    opener.focus();
    fireEvent.click(opener);
    const trigger = screen.getByRole('button', { name: t('common.moreActions') });
    fireEvent.click(trigger);
    screen.getByText('Menu action').focus();
    const dialog = screen.getByRole('dialog');
    expect(fireEvent(dialog, new Event('cancel', { cancelable: true }))).toBe(false);
    expect(screen.queryByText('Menu action')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole('heading', { name: 'First' })).toBeTruthy();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
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
    const input = screen.getByLabelText('Name');
    input.focus();
    fireEvent.change(input, { target: { value: 'Renamed' } });
    expect(document.activeElement).toBe(input);
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
