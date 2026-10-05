import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { joinNodes, rich } from './rich';

describe('rich', () => {
  it('puts the parts where the placeholders are, also inside bold text', () => {
    const { container } = render(
      <p>{rich('howWeWork.rules.new_card.line', { access: <i>fejlesztő</i>, stage: <u>Indulhat</u> })}</p>,
    );
    expect(container.querySelector('b')?.textContent).toBe('Kártyát felvehet');
    expect(container.querySelector('i')?.textContent).toBe('fejlesztő');
    expect(container.querySelector('u')?.textContent).toBe('Indulhat');
    expect(container.textContent).not.toContain('{');
    expect(container.textContent).not.toContain('**');
  });

  it('joins nodes like a sentence: "a, b és c"', () => {
    const { container } = render(<p>{joinNodes([<b key="a">a</b>, <b key="b">b</b>, <b key="c">c</b>])}</p>);
    expect(container.textContent).toBe('a, b és c');
    expect(container.querySelectorAll('b')).toHaveLength(3);
  });
});
