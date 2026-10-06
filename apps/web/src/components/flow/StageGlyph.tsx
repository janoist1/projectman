import type { StageKind } from '@projectman/shared';

/**
 * The mark of a stage on a flow: its shape says the kind, the colour (the parent's `color`) only
 * accents it. Decorative: the kind is always written next to it.
 */
export function StageGlyph({
  kind,
  size = 22,
  glyphId,
}: {
  kind: StageKind;
  size?: number;
  /** Names the mark for FlowLine, which joins the marks of a flow. */
  glyphId?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      aria-hidden="true"
      focusable="false"
      data-glyph={glyphId}
      style={{ display: 'block' }}
    >
      {kind === 'queue' ? (
        <circle cx="11" cy="11" r="7" fill="var(--c-surface)" stroke="currentColor" strokeWidth="2.5" />
      ) : kind === 'work' ? (
        <circle cx="11" cy="11" r="8" fill="currentColor" />
      ) : kind === 'step' ? (
        <rect x="5" y="5" width="12" height="12" rx="2" transform="rotate(45 11 11)" fill="currentColor" />
      ) : kind === 'release' ? (
        <path
          d="M11 3 19.5 18h-17z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle cx="11" cy="11" r="9" fill="currentColor" />
          <path
            d="m7 11.2 2.7 2.7L15.2 8.5"
            fill="none"
            stroke="var(--c-surface)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
