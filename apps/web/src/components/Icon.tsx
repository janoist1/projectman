import type { ReactNode } from 'react';

/** Stroke icons on a 24×24 grid, drawn after the mockups. Always decorative (aria-hidden). */
const icons = {
  logo: (
    <>
      <path d="M6.5 6v12" />
      <path d="M12 6v7.5" />
      <path d="M17.5 6v4" />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="4" width="5" height="16" rx="1.6" />
      <rect x="10" y="4" width="5" height="11" rx="1.6" />
      <rect x="16.5" y="4" width="4.5" height="7" rx="1.6" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19.5c0-3.2 2.7-5.3 6-5.3s6 2.1 6 5.3" />
      <path d="M16 5.3a3 3 0 0 1 0 5.4" />
      <path d="M18.2 14.6c1.7.7 2.8 2.3 2.8 4.9" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5l2.4-7.1a2 2 0 0 1 1.9-1.4h8.4a2 2 0 0 1 1.9 1.4l2.4 7.1" />
      <path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5h-4.8l-1.4 2.3h-4.6l-1.4-2.3z" />
    </>
  ),
  messages: <path d="M20.5 11.6a8 8 0 0 1-11.7 7.1L4 20l1.3-4.4a8 8 0 1 1 15.2-4z" />,
  settings: (
    <>
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <circle cx="15" cy="7" r="2" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  filter: <path d="M4 5.5h16l-6 7.2v5.3l-4 1.8v-7.1z" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  close: (
    <>
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </>
  ),
  check: <path d="M5 12.5l4.3 4.3L19 7.2" />,
  exclamation: (
    <>
      <path d="M12 5v8.5" />
      <path d="M12 18.5v.3" />
    </>
  ),
  wait: <path d="M12 6v6.5l3.5 2" />,
  prOpen: (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="18" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M17.5 15.8V9.5a3 3 0 0 0-3-3H11" />
      <path d="M13 4.2l-2.3 2.3 2.3 2.3" />
    </>
  ),
  prMerged: (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="13" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M6.5 8.5c0 3.2 3 4.5 8.8 4.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2.2" />
      <circle cx="6.5" cy="18.5" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <path d="M6.5 7.7v8.6" />
      <path d="M17.5 10.2c0 3.8-3.6 4.6-9.3 6.4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="2" />
      <rect x="4" y="13" width="16" height="7" rx="2" />
      <path d="M8 7.5h.01" />
      <path d="M8 16.5h.01" />
    </>
  ),
  code: (
    <>
      <path d="M8.5 7L3.5 12l5 5" />
      <path d="M15.5 7l5 5-5 5" />
    </>
  ),
  flask: (
    <>
      <path d="M9 3.5h6" />
      <path d="M10 3.5v5.8L4.9 18a2 2 0 0 0 1.7 3h10.8a2 2 0 0 0 1.7-3L14 9.3V3.5" />
      <path d="M7.4 14.5h9.2" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.7 3.1-6 7-6s7 2.3 7 6" />
    </>
  ),
  shield: <path d="M12 3.5l7 2.8v5.6c0 4.2-3 7.3-7 8.6-4-1.3-7-4.4-7-8.6V6.3z" />,
  shieldCheck: (
    <>
      <path d="M12 3.5l7 2.8v5.6c0 4.2-3 7.3-7 8.6-4-1.3-7-4.4-7-8.6V6.3z" />
      <path d="M9 12.2l2.1 2.1 4-4.1" />
    </>
  ),
  doc: (
    <>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13.5 3.5V9H19" />
    </>
  ),
  paperclip: (
    <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4l7.5-7.5" />
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5L12 15l4.5-4.5" />
      <path d="M5 19.5h14" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7l.8 12.5h9.4L17.5 7" />
    </>
  ),
  pencil: (
    <>
      <path d="M4.5 19.5h4l10-10-4-4-10 10z" />
      <path d="M13 7l4 4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M7.5 9.5l3 2.5-3 2.5" />
      <path d="M12.5 15h4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </>
  ),
  timer: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 9.5V13l2.5 1.5" />
      <path d="M10 2.5h4" />
    </>
  ),
  send: (
    <>
      <path d="M4.5 12L20 4.5 15.5 20l-3-6.5z" />
      <path d="M12.5 13.5L20 4.5" />
    </>
  ),
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5L11 13" />
      <path d="M17.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V8.5A1.5 1.5 0 0 1 6 7h4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.9 3.7" />
      <path d="M6.3 7.6A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5c1.5 0 2.9-.4 4.1-1" />
      <path d="M9.9 10a3 3 0 0 0 4.1 4.1" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" />,
  undo: (
    <>
      <path d="M9 5L4.5 9.5 9 14" />
      <path d="M4.5 9.5h9.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" />
    </>
  ),
  list: (
    <>
      <path d="M9 6.5h11" />
      <path d="M9 12h11" />
      <path d="M9 17.5h11" />
      <path d="M4.5 6.5h.01" />
      <path d="M4.5 12h.01" />
      <path d="M4.5 17.5h.01" />
    </>
  ),
  sparkle: <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z" />,
  tool: <path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5a4 4 0 0 0-2-2z" />,
  commit: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3.5 12h5" />
      <path d="M15.5 12h5" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4" />
      <path d="M10 16l-4-4 4-4" />
      <path d="M6 12h9" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3.5l8.5 4.5-8.5 4.5L3.5 8z" />
      <path d="M3.5 12.5l8.5 4.5 8.5-4.5" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M12 8v4.5l3 1.8" />
    </>
  ),
  bold: <path d="M7 4.5h5.5a3.5 3.5 0 0 1 0 7H7zM7 11.5h6.5a3.5 3.5 0 0 1 0 7H7z" />,
  italic: (
    <>
      <path d="M10 5h7" />
      <path d="M7 19h7" />
      <path d="M14.5 5l-5 14" />
    </>
  ),
  heading: (
    <>
      <path d="M6 5v14" />
      <path d="M18 5v14" />
      <path d="M6 12h12" />
    </>
  ),
  listOrdered: (
    <>
      <path d="M10 6.5h10.5" />
      <path d="M10 12h10.5" />
      <path d="M10 17.5h10.5" />
      <path d="M4.5 5.5l1.5-1v5" />
      <path d="M4 14.5c0-1 2.5-1 2.5.3 0 1-2.5 2.2-2.5 2.2h2.7" />
    </>
  ),
  taskList: (
    <>
      <rect x="3.5" y="4.5" width="5" height="5" rx="1.2" />
      <path d="M4.8 7l1.2 1.2 1.8-2.2" />
      <path d="M12 7h8.5" />
      <rect x="3.5" y="14.5" width="5" height="5" rx="1.2" />
      <path d="M12 17h8.5" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="18.5" cy="12" r="1.3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 20, strokeWidth = 1.9, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0 }}
    >
      {icons[name]}
    </svg>
  );
}
