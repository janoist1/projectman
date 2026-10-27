import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { Dialog } from './Dialog';

describe('Dialog focus', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');

  beforeEach(() => {
    // jsdom has no showModal; mimic the browser, which moves the focus to the first focusable element.
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
      this.querySelector<HTMLElement>('button, input, textarea, select')?.focus();
    };
  });

  afterEach(() => {
    if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  });

  it('keeps the focus on an autoFocus field instead of the close button', () => {
    render(
      <Dialog open onClose={() => {}} title="Invite">
        <input aria-label="email" autoFocus />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('email'));
  });

  it('focuses the close button when no field asks for the focus', () => {
    render(
      <Dialog open onClose={() => {}} title="Invite">
        <input aria-label="email" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('common.close') }));
  });
});
