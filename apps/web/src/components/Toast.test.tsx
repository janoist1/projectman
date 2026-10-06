import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { ToastProvider } from './Toast';
import { useToast } from './toastContext';

function TestConsumer({
  message = 'Toast message',
  tone,
  sticky,
  items,
}: {
  message?: string;
  tone?: 'ok' | 'error' | 'info';
  sticky?: boolean;
  items?: Array<{ key: string; text: string; to?: string; bare?: boolean }>;
}) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(message, tone, { sticky, items })}>
      Show Toast
    </button>
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a toast message when triggered and dismisses on close button click', () => {
    render(
      <ToastProvider>
        <TestConsumer message="Operation completed" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Operation completed')).toBeTruthy();

    const dismissButton = screen.getByRole('button', { name: t('toast.dismiss') });
    fireEvent.click(dismissButton);
    expect(screen.queryByText('Operation completed')).toBeNull();
  });

  it('auto-dismisses ok toast after 4500ms', () => {
    render(
      <ToastProvider>
        <TestConsumer message="Auto closing" tone="ok" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Auto closing')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4499);
    });
    expect(screen.getByText('Auto closing')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Auto closing')).toBeNull();
  });

  it('auto-dismisses error toast after 7000ms', () => {
    render(
      <ToastProvider>
        <TestConsumer message="Something failed" tone="error" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Something failed')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.getByText('Something failed')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.queryByText('Something failed')).toBeNull();
  });

  it('keeps sticky toast visible past timeout until manually dismissed', () => {
    render(
      <ToastProvider>
        <TestConsumer message="Important notice" sticky />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Important notice')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText('Important notice')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: t('toast.dismiss') }));
    expect(screen.queryByText('Important notice')).toBeNull();
  });

  it('clears active auto-dismiss timers when unmounted (PM-282)', () => {
    const { unmount } = render(
      <ToastProvider>
        <TestConsumer message="Will unmount" tone="error" />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Will unmount')).toBeTruthy();

    // Unmount before the 7000ms timer fires
    unmount();

    // Advancing timers should not throw any unhandled error (e.g. ReferenceError: window is not defined)
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10000);
      });
    }).not.toThrow();
  });

  it('renders listed items with router link when provided', () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <TestConsumer
            message="Batch update"
            items={[{ key: 'AC-1', text: 'updated', to: '/p/AC/tasks/AC-1' }]}
          />
        </ToastProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    expect(screen.getByText('Batch update')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'AC-1' });
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-1');
  });
});
