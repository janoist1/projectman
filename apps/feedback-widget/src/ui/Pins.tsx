import { useState } from 'preact/hooks';
import type { Controller, State } from '../controller';
import { tipOf } from '../anchor';
import { t } from '../i18n';
import { Avatar, colorVar, personName } from './common';
import { useViewTick } from './hooks';

const ARIA_TEXT = 80;

/** The marks of this page as pins at their document coordinates (they scroll with the page). */
export function Pins({ controller, state }: { controller: Controller; state: State }) {
  useViewTick(true);
  const [hot, setHot] = useState<string | null>(null);
  const activeId = state.card?.type === 'thread' ? state.card.markId : null;
  const scroll = { x: window.scrollX, y: window.scrollY };

  const items = Object.values(state.marks)
    .filter((mark) => controller.isOnThisPage(mark))
    .map((mark) => ({ mark, resolution: controller.resolutionOf(mark) }));

  return (
    <div class="pins">
      {items.map(({ mark, resolution }) => {
        const tip = tipOf(resolution, mark.anchor, scroll);
        if (!tip || resolution.place !== 'located') return null;
        const closed = mark.status === 'closed';
        const active = activeId === mark.id || hot === mark.id;
        const text = mark.body.length > ARIA_TEXT ? `${mark.body.slice(0, ARIA_TEXT)}…` : mark.body;
        const label = t(resolution.changed ? 'pin.ariaChanged' : 'pin.aria', {
          name: mark.author.name,
          text,
        });
        const outline =
          resolution.element && hot === mark.id ? resolution.element.getBoundingClientRect() : null;
        return (
          <div key={mark.id} class="pin-wrap">
            {mark.anchor.kind === 'area' && resolution.rect && (
              <div
                class={`frame${closed ? ' closed' : ''}`}
                style={{
                  left: `${resolution.rect.x}px`,
                  top: `${resolution.rect.y}px`,
                  width: `${resolution.rect.width}px`,
                  height: `${resolution.rect.height}px`,
                  '--pc': colorVar(mark.author),
                }}
                aria-hidden="true"
              />
            )}
            {outline && (
              <div
                class="outline"
                style={{
                  left: `${outline.left + scroll.x}px`,
                  top: `${outline.top + scroll.y}px`,
                  width: `${outline.width}px`,
                  height: `${outline.height}px`,
                  '--pc': colorVar(mark.author),
                }}
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              class={`pin${closed ? ' closed' : ''}${active ? ' active' : ''}${state.fresh.includes(mark.id) ? ' pop' : ''}`}
              style={{ left: `${tip.x}px`, top: `${tip.y}px`, '--pc': colorVar(mark.author) }}
              aria-label={label}
              aria-expanded={activeId === mark.id}
              onClick={() => controller.openMark(mark.id)}
              onPointerEnter={() => setHot(mark.id)}
              onPointerLeave={() => setHot((current) => (current === mark.id ? null : current))}
              onFocus={() => setHot(mark.id)}
              onBlur={() => setHot((current) => (current === mark.id ? null : current))}
            >
              <span class="pin-head">
                <Avatar person={mark.author} />
                {mark.unread && <i class="unread" aria-hidden="true" />}
                {resolution.changed && (
                  <b class="changed" aria-hidden="true">
                    !
                  </b>
                )}
              </span>
              <span class="pin-name" aria-hidden="true">
                {personName(mark.author)}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
