import { useState } from 'preact/hooks';
import type { Controller, Draft, State } from '../controller';
import { areaOf, tipOf } from '../anchor';
import { t } from '../i18n';
import { Avatar, colorVar, personName } from './common';
import { useViewTick } from './hooks';

const ARIA_TEXT = 80;

/**
 * What a new mark marks, drawn on the page in the marker's colour while its card is open: a pin with the
 * monogram for a point, a dashed frame for an area, an outline for an element.
 */
export function DraftPin({
  controller,
  state,
  draft,
}: {
  controller: Controller;
  state: State;
  draft: Draft;
}) {
  useViewTick(true);
  const person = state.me ?? state.session?.me ?? null;
  const scroll = { x: window.scrollX, y: window.scrollY };
  const resolution = controller.resolutionOf(draft.target);
  const tip = tipOf(resolution, draft.target.anchor, scroll);
  if (!person || !tip || resolution.place !== 'located') return null;
  const color = { '--pc': colorVar(person) };
  // Only an element mark outlines its element; a point or an area pinned to one just follows it.
  const box =
    draft.target.anchor.kind === 'element' ? (resolution.element?.getBoundingClientRect() ?? null) : null;
  const area = areaOf(resolution, draft.target.anchor, scroll);
  return (
    <div class="pins" aria-hidden="true">
      {area && (
        <div
          class="frame draft"
          style={{
            left: `${area.x}px`,
            top: `${area.y}px`,
            width: `${area.width}px`,
            height: `${area.height}px`,
            ...color,
          }}
        />
      )}
      {box && (
        <div
          class="outline"
          style={{
            left: `${box.left + scroll.x}px`,
            top: `${box.top + scroll.y}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            ...color,
          }}
        />
      )}
      <div class="pin draft" style={{ left: `${tip.x}px`, top: `${tip.y}px`, ...color }}>
        <span class="pin-head">
          <Avatar person={person} />
        </span>
      </div>
    </div>
  );
}

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
          mark.anchor.kind === 'element' && resolution.element && hot === mark.id
            ? resolution.element.getBoundingClientRect()
            : null;
        const area = areaOf(resolution, mark.anchor, scroll);
        return (
          <div key={mark.id} class="pin-wrap">
            {area && (
              <div
                class={`frame${closed ? ' closed' : ''}`}
                style={{
                  left: `${area.x}px`,
                  top: `${area.y}px`,
                  width: `${area.width}px`,
                  height: `${area.height}px`,
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
