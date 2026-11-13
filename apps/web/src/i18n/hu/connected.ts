/** A step made through a connected Claude (decision 66, PM-1075). */
export const connected = {
  chip: 'Claude',
  chipHolder: 'Claude · {holder}',
  approvedBy: 'jóváhagyta: {name}',
  label: '{name} (Claude)',
  labelHolder: '{name} (Claude · {holder})',
  /** The author line of a written entry (PM-1290): the name, then how the entry was made. */
  via: '{name} · csatlakoztatott Claude-on át',
  title: 'Csatlakozott Claude',
  chipAria: 'Csatlakozott Claude, gazdája: {holder}. Részletek',
  avatar: '{name}, csatlakozott Claude-on át',
  detail: 'Csatlakozott Claude',
  holder: 'gazdája: {name}',
  key: 'kulcs:',
  activity: 'Mit tett ez a kulcs?',
} as const;
