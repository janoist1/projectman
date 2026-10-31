import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setCurrentLanguage } from './language';
import { joinNodes, rich } from './rich';

describe('rich', () => {
  it('puts the parts where the placeholders are, also inside bold text', () => {
    const { container } = render(
      <p>{rich('howWeWork.rules.fix_limit.lineLead', { limit: <i>3</i>, lead: <u>Vezető</u> })}</p>,
    );
    expect(container.querySelector('b')?.textContent).toContain('3');
    expect(container.querySelector('i')?.textContent).toBe('3');
    expect(container.querySelector('u')?.textContent).toBe('Vezető');
    expect(container.textContent).not.toContain('{');
    expect(container.textContent).not.toContain('**');
  });

  it('hands a number to the message, so a plural form picks its word (PM-1180)', () => {
    setCurrentLanguage('en');
    const { container } = render(
      <p>{rich('howWeWork.stage.loopNoLabel', { stage: <u>Dev</u>, limit: 1, after: <i>then</i> })}</p>,
    );
    expect(container.textContent).toContain('1 round');
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toContain('{');
  });

  it('joins nodes like a sentence: "a, b és c"', () => {
    const { container } = render(<p>{joinNodes([<b key="a">a</b>, <b key="b">b</b>, <b key="c">c</b>])}</p>);
    expect(container.textContent).toBe('a, b és c');
    expect(container.querySelectorAll('b')).toHaveLength(3);
  });
});
