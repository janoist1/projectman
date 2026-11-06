import { afterEach, describe, expect, it } from 'vitest';
import { setWidgetLanguage } from './i18n';
import { mountWidget } from './widget';

describe('mountWidget', () => {
  afterEach(() => {
    document.documentElement.lang = '';
    setWidgetLanguage('hu');
  });

  it('marks the root element with the language of the embedding page', () => {
    document.documentElement.lang = 'en';
    const mounted = mountWidget({
      win: window,
      base: 'https://projectman.example',
      projectKey: 'PM',
      css: '',
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(mounted.host.shadowRoot?.querySelector('.w')?.getAttribute('lang')).toBe('en');
    mounted.unmount();
  });
});
