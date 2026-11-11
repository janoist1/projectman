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

function ActionConsumer({ run }: { run(): void }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show('Saved', 'ok', { action: { label: 'Undo it', run } })}>
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
    expect(vi.getTimerCount()).toBe(1);

    // Unmount before the 7000ms timer fires
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs the action once and closes the toast', () => {
    const run = vi.fn();
    render(
      <ToastProvider>
        <ActionConsumer run={run} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo it' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('keeps a toast with an action for at least 8 seconds', () => {
    render(
      <ToastProvider>
        <ActionConsumer run={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    act(() => {
      vi.advanceTimersByTime(7900);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('does not close a toast with an action while the pointer is over it', () => {
    render(
      <ToastProvider>
        <ActionConsumer run={() => {}} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show Toast' }));
    const action = screen.getByRole('button', { name: 'Undo it' });
    fireEvent.mouseEnter(action.parentElement!);
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
  });

  function Burst() {
    const toast = useToast();
    return (
      <>
        <button
          type="button"
          onClick={() => toast.show('Deleted', 'ok', { action: { label: 'Undo it', run: () => {} } })}
        >
          delete
        </button>
        <button
          type="button"
          onClick={() => toast.show('Deleted again', 'ok', { action: { label: 'Undo it', run: () => {} } })}
        >
          delete again
        </button>
        <button type="button" onClick={() => toast.show('Saved')}>
          save
        </button>
        <button type="button" onClick={() => toast.show('Failed', 'error')}>
          fail
        </button>
      </>
    );
  }

  const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

  it('shows one plain toast at a time: the new one replaces the old one and its timer', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );
    click('save');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    click('fail');
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByText('Failed')).toBeTruthy();
    // The error runs its own 7 s, not what is left of the replaced one.
    act(() => {
      vi.advanceTimersByTime(6900);
    });
    expect(screen.getByText('Failed')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Failed')).toBeNull();
  });

  it('keeps a toast with an action while plain toasts come and go below it', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );
    click('delete');
    click('save');
    click('save');
    click('fail');
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo it' })).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.queryByText('Saved')).toBeNull();
    const region = screen.getByRole('status');
    expect(region.textContent?.indexOf('Deleted')).toBeLessThan(region.textContent?.indexOf('Failed') ?? 0);
  });

  it('shows the same toast once and restarts its time', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );
    click('save');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    click('save');
    expect(screen.getAllByText('Saved')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('holds a plain toast under the pointer and lets the latest one in when it leaves', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );
    click('save');
    const toast = screen.getByText('Saved').parentElement!;
    fireEvent.mouseEnter(toast);
    click('fail');
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull();
    fireEvent.mouseLeave(toast);
    expect(screen.queryByText('Saved')).toBeNull();
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('does not replace a toast while the focus is inside it', () => {
    render(
      <ToastProvider>
        <Burst />
      </ToastProvider>,
    );
    click('delete');
    const undo = screen.getByRole('button', { name: 'Undo it' });
    fireEvent.focus(undo);
    click('delete again');
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Undo it' })).toBe(undo);
    fireEvent.blur(undo);
    expect(screen.getByText('Deleted again')).toBeTruthy();
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
