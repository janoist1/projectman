import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown task lists', () => {
  it('renders unchecked and checked items as disabled read-only checkboxes with safe inline text', () => {
    const { container } = render(
      <Markdown text={'- [ ] Pending\n- [x] **Done**\n- [X] <img src=x onerror=alert(1)>\n- Ordinary'} />,
    );
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, true, true]);
    expect(boxes.every((box) => box.disabled && box.readOnly)).toBe(true);
    expect(screen.getByLabelText('Pending')).toBe(boxes[0]);
    fireEvent.click(boxes[0]!);
    expect(boxes[0]!.checked).toBe(false);
    expect(container.querySelector('strong')?.textContent).toBe('Done');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(4);
  });
  it('keeps task syntax literal inside fenced code and ordered lists', () => {
    const { container } = render(<Markdown text={'```\n- [x] code\n```\n1. [ ] ordered'} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('- [x] code');
    expect(container.querySelector('ol li')?.textContent).toBe('[ ] ordered');
  });
});
