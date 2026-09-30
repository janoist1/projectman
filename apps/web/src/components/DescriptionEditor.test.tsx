import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { DescriptionEditor } from './DescriptionEditor';

function Editor({ initial = 'alpha beta\ngamma' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <DescriptionEditor label={t('task.description')} value={value} onChange={setValue} />;
}
const textarea = () => screen.getByLabelText(t('task.description')) as HTMLTextAreaElement;

describe('DescriptionEditor', () => {
  it.each([
    ['bold', '**beta**'],
    ['italic', '*beta*'],
    ['code', '`beta`'],
    ['link', '[beta](https://example.com)'],
  ] as const)('wraps only the selected text with %s and retains the selection', (action, formatted) => {
    render(<Editor />);
    const input = textarea();
    input.focus();
    input.setSelectionRange(6, 10);
    fireEvent.click(screen.getByRole('button', { name: t(`editor.${action}`) }));
    expect(input.value).toBe(`alpha ${formatted}\ngamma`);
    expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe('beta');
  });
  it.each([
    ['bullet', '- alpha beta\n- gamma'],
    ['numbered', '1. alpha beta\n2. gamma'],
    ['taskList', '- [ ] alpha beta\n- [ ] gamma'],
    ['heading', '## alpha beta\n## gamma'],
  ] as const)('prefixes selected lines with %s even for a partial selection', (action, expected) => {
    render(<Editor />);
    const input = textarea();
    input.setSelectionRange(6, 14);
    fireEvent.click(screen.getByRole('button', { name: t(`editor.${action}`) }));
    expect(input.value).toBe(expected);
  });
  it('does not prefix the next line when selection ends at a line break', () => {
    render(<Editor />);
    const input = textarea();
    input.setSelectionRange(0, 11);
    fireEvent.click(screen.getByRole('button', { name: t('editor.bullet') }));
    expect(input.value).toBe('- alpha beta\ngamma');
  });
  it.each([
    ['b', 'bold'],
    ['i', 'italic'],
    ['k', 'link'],
  ] as const)('supports Ctrl/Cmd+%s', (key, action) => {
    render(<Editor initial="beta" />);
    const input = textarea();
    input.setSelectionRange(0, 4);
    fireEvent.keyDown(input, { key, metaKey: true });
    const formatted = input.value;
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(input.value).toBe('beta');
    input.setSelectionRange(0, 4);
    fireEvent.keyDown(input, { key, ctrlKey: true });
    expect(input.value).toBe(formatted);
    expect(screen.getByRole('button', { name: t(`editor.${action}`) })).toBeTruthy();
  });
  it('previews safe markdown and preserves the draft when returning to write', () => {
    const source = '**Example**\n- [x] Shipped\n<script>alert(1)</script>\n[unsafe](javascript:alert(1))';
    render(<Editor initial={source} />);
    fireEvent.click(screen.getByRole('button', { name: t('editor.preview') }));
    const preview = screen.getByRole('region', { name: t('editor.preview') });
    expect(preview.querySelector('strong')?.textContent).toBe('Example');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.querySelector('a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('editor.write') }));
    expect(textarea().value).toBe(source);
  });
});
