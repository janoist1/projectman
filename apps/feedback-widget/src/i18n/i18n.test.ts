import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en';
import { hu } from './hu';
import { setWidgetLanguage, t, widgetLanguage } from './index';

/** The parameter names a text uses; `{name|one|other}` counts as `{name}`. */
const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)(?:\|[^|}]*\|[^}]*)?\}/g)].map((match) => match[1]!).sort();

describe('widgetLanguage', () => {
  it.each([
    ['the page language when it names one', 'en', 'hu-HU', 'en'],
    ['the browser language when the page names none', '', 'hu-HU', 'hu'],
    ['English for anything that is not Hungarian', 'de-DE', 'hu', 'en'],
  ])('uses %s', (_name, htmlLang, navigatorLanguage, expected) => {
    expect(widgetLanguage(htmlLang, navigatorLanguage)).toBe(expected);
  });
});

describe('dictionaries', () => {
  it('give every key the same parameters and no empty text', () => {
    for (const key of Object.keys(hu) as (keyof typeof hu)[]) {
      expect(en[key].trim(), key).not.toBe('');
      expect(placeholders(en[key]), key).toEqual(placeholders(hu[key]));
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(hu).sort());
  });
});

describe('t', () => {
  afterEach(() => setWidgetLanguage('hu'));

  it('picks the English plural form and fills in the number', () => {
    setWidgetLanguage('en');
    expect(t('thread.commentCount', { count: 1 })).toBe('1 comment');
    expect(t('thread.commentCount', { count: 3 })).toBe('3 comments');
  });
});
