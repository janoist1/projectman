import { useEffect } from 'preact/hooks';
import type { Controller } from '../controller';
import { Launcher } from './Launcher';
import { Menu } from './Menu';
import { NewMarkCard } from './NewMarkCard';
import { Help, Notice, Welcome } from './Notices';
import { Panel } from './Panel';
import { Pins } from './Pins';
import { Targeting } from './Targeting';
import { ThreadCard } from './ThreadCard';
import { useControllerState, useIsPhone } from './hooks';

/** The widget's whole interface. With no code and no stored session nothing is rendered. */
export function App({ controller }: { controller: Controller }) {
  const state = useControllerState(controller);
  const phone = useIsPhone();

  useEffect(() => {
    // Esc closes one thing at a time; when nothing of ours is open the page keeps the key.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && controller.escape()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [controller]);

  if (state.notice) return <Notice controller={controller} kind={state.notice} phone={phone} />;
  if (state.phase === 'off') return null;

  const showMarks = state.phase === 'ready' && !state.hidden;
  return (
    <>
      {showMarks && <Pins controller={controller} state={state} />}
      {state.mode && <Targeting key={state.mode} controller={controller} mode={state.mode} />}
      <Launcher controller={controller} state={state} />
      {state.phase === 'ready' && (
        <>
          {state.card?.type === 'new' && state.draft && (
            <NewMarkCard controller={controller} state={state} draft={state.draft} phone={phone} />
          )}
          {showMarks && state.card?.type === 'thread' && (
            <ThreadCard
              key={state.card.markId}
              controller={controller}
              state={state}
              markId={state.card.markId}
              phone={phone}
            />
          )}
          {state.panel && <Panel controller={controller} state={state} phone={phone} />}
          {state.menuOpen && <Menu controller={controller} state={state} phone={phone} />}
          {state.helpOpen && <Help controller={controller} phone={phone} />}
          {state.welcomeOpen && <Welcome controller={controller} state={state} phone={phone} />}
          {state.flash && (
            <div class="toast" role="status">
              {state.flash}
            </div>
          )}
        </>
      )}
    </>
  );
}
