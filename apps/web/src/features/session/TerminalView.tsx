import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { useSocket } from '../../api/SocketProvider';
import { Spinner } from '../../components/States';
import { t } from '../../i18n/t';
import styles from './TerminalView.module.css';

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * The session's real terminal (the interactive Claude Code TUI) over the websocket:
 * attach → snapshot → live output; keystrokes go back as terminal input; the PTY follows
 * the size of this view.
 */
export default function TerminalView({ sessionId }: { sessionId: string }) {
  const socket = useSocket();
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setReady(false);
    const terminal = new Terminal({
      fontFamily: cssVar('--font-mono', 'monospace'),
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: cssVar('--c-term-bg', '#161614'),
        foreground: cssVar('--c-term-fg', '#f5f4ef'),
        cursor: cssVar('--c-term-fg', '#f5f4ef'),
        selectionBackground: cssVar('--c-term-line', '#2e2d29'),
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    let disposed = false;
    let lastSize = '';
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const safeFit = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // The container can be hidden or zero-sized for a moment.
      }
    };
    const sendSize = () => {
      const size = `${terminal.cols}x${terminal.rows}`;
      if (size === lastSize) return;
      lastSize = size;
      socket.terminalResize(sessionId, terminal.cols, terminal.rows);
    };

    const detach = socket.attachTerminal(sessionId, {
      onSnapshot: (data, cols, rows) => {
        terminal.reset();
        terminal.resize(cols, rows);
        terminal.write(data, () => {
          safeFit();
          sendSize();
          setReady(true);
          terminal.focus();
        });
      },
      onData: (data) => terminal.write(data),
    });
    const input = terminal.onData((data) => socket.terminalInput(sessionId, data));
    const resized = terminal.onResize(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(sendSize, 150);
    });
    const observer = new ResizeObserver(() => safeFit());
    observer.observe(container);
    requestAnimationFrame(safeFit);
    void document.fonts?.ready.then(safeFit);

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      resized.dispose();
      detach();
      terminal.dispose();
    };
  }, [socket, sessionId]);

  return (
    <div className={styles.wrap}>
      <div className={styles.terminal} ref={containerRef} role="region" aria-label={t('session.terminal.label')} />
      {ready ? null : (
        <div className={styles.overlay}>
          <Spinner />
          <span>{t('session.terminal.connecting')}</span>
        </div>
      )}
      <p className={styles.hint}>{t('session.terminal.hint')}</p>
    </div>
  );
}
