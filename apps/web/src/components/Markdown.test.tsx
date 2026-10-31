import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { mockProject } from '../test/mockProject';
import { Markdown } from './Markdown';

describe('Markdown document links', () => {
  const text = 'Lásd [Terv › 1. Cél](doc:terv#1-cel) és [a terv](doc:terv).';

  it('draws a link to the project documents page in the same tab, with the section as hash', () => {
    const p = mockProject();
    p.render(<Markdown text={text} />, '/p/AC');
    const section = screen.getByRole('link', { name: 'Terv › 1. Cél' });
    expect(section.getAttribute('href')).toBe('/p/AC/docs/terv#1-cel');
    expect(section.getAttribute('target')).toBeNull();
    expect(section.getAttribute('title')).toBe(t('documentLink.open', { ref: 'terv#1-cel' }));
    expect(section.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('link', { name: 'a terv' }).getAttribute('href')).toBe('/p/AC/docs/terv');
  });

  it('shows only the text outside a project and for a viewer who may not read documents', () => {
    const p = mockProject();
    const { unmount } = render(<Markdown text={text} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('a terv').getAttribute('title')).toBe('terv');
    unmount();
    p.render(<Markdown text={text} />, '/p/AC', {
      me: { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'client' }] },
    });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Terv › 1. Cél')).toBeTruthy();
  });

  it('leaves an invalid slug as plain text and keeps a document link out of code', () => {
    const p = mockProject();
    const { container } = p.render(
      <Markdown text={'[bad](doc:Bad Slug) `[code](doc:terv)` [web](https://example.com)'} />,
      '/p/AC',
    );
    expect(container.textContent).toContain('[bad](doc:Bad Slug)');
    expect(container.querySelector('code')?.textContent).toBe('[code](doc:terv)');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link').getAttribute('target')).toBe('_blank');
  });
});

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
  it('gives headings anchors only where the page asks for them, and reads ~~~ fences like the outline', () => {
    const text = '# Cím\n\n~~~\n# nem fejezet\n~~~\n\n## Áttekintés\n\n## Áttekintés';
    const links = { copyLabel: (heading: { text: string }) => heading.text, onCopy: () => {} };
    const { container, rerender } = render(<Markdown text={text} headingLinks={links} />);
    expect([...container.querySelectorAll('h2, h3')].map((heading) => heading.id)).toEqual([
      'cim',
      'attekintes',
      'attekintes-2',
    ]);
    expect(container.querySelector('pre')?.textContent).toBe('# nem fejezet');
    rerender(<Markdown text={text} />);
    expect(container.querySelectorAll('[id]')).toHaveLength(0);
  });
  it('keeps task syntax literal inside fenced code and ordered lists', () => {
    const { container } = render(<Markdown text={'```\n- [x] code\n```\n1. [ ] ordered'} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('- [x] code');
    expect(container.querySelector('ol li')?.textContent).toBe('[ ] ordered');
  });
});
