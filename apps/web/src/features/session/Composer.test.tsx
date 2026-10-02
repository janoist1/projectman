import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/t';
import { Composer } from './Composer';

afterEach(() => vi.restoreAllMocks());

function phone() {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }));
}

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
});
