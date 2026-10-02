import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { Composer } from './Composer';

afterEach(() => vi.restoreAllMocks());

/** A screen where the media queries accepted by `matching` apply. */
function screenMatching(matching: (query: string) => boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: matching(query),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

const phone = () => screenMatching(() => true);

const input = () => screen.getByLabelText(t('session.composer.label')) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: t('common.send') }) as HTMLButtonElement;

describe('Composer', () => {
  it('is one line with a send button that waits for text', () => {
    render(<Composer onSend={() => {}} />);
    expect(input().rows).toBe(1);
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(input(), { target: { value: 'Mehet?' } });
    expect(sendButton().disabled).toBe(false);
  });

  it('sends on Enter with a keyboard, and Shift+Enter leaves the line break to the field', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.change(input(), { target: { value: ' Mehet? ' } });
    expect(screen.getByText(t('session.composer.hint'))).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Mehet?');
    expect(input().value).toBe('');
  });

  it('on a phone Enter writes a new line, and only the button sends', () => {
    phone();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'Mehet?' } });
    expect(screen.queryByText(t('session.composer.hint'))).toBeNull();
    const enter = fireEvent.keyDown(input(), { key: 'Enter' });
    // Not prevented: the browser inserts the line break.
    expect(enter).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('Mehet?');
    expect(input().value).toBe('');
  });

  it('lets the touch screen, not the width, decide about Enter', () => {
    const onSend = vi.fn();
    // A tablet: wide, but touched.
    screenMatching((query) => query.includes('coarse'));
    const { unmount } = render(<Composer onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'Mehet?' } });
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    unmount();
    // A narrow desktop window: a keyboard, so Enter sends.
    screenMatching((query) => query.includes('max-width'));
    render(<Composer onSend={onSend} />);
    fireEvent.change(input(), { target: { value: 'Mehet?' } });
    expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(false);
    expect(onSend).toHaveBeenCalledWith('Mehet?');
  });
});
