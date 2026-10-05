import { createContext, useContext } from 'react';
import type { LabelView, MemberConfig, ProjectConfig, TeamMap } from '@projectman/shared';
import type { MemberLike } from '../../lib/members';
import { showValue } from './model';
import type { ShowTarget } from './model';

/** What the parts of the page share: the map, the way to open an item's details, and whether the viewer may edit. */
export interface MapView {
  projectKey: string;
  map: TeamMap;
  config: ProjectConfig;
  labels: LabelView[];
  /** Only an admin sees the links to the settings. */
  canEdit: boolean;
  /** Role id to the catalogue's name; an id without a catalogue entry is shown as it is. */
  roleName: (id: string) => string;
  selected: ShowTarget | null;
  /** Opens an item's details; `opener` is where the focus goes back to when they close. */
  select: (target: ShowTarget, opener?: HTMLElement | null) => void;
  stageName: (id: string) => string;
  member: (handle: string) => MemberConfig | undefined;
}

const MapContext = createContext<MapView | null>(null);
export const MapProvider = MapContext.Provider;

export function useMapView(): MapView {
  const value = useContext(MapContext);
  if (!value) throw new Error('useMapView outside the how-we-work page');
  return value;
}

/** What an element needs to open an item's details: whether it is open, its `?show=` value, and the opener. */
export function useShowTarget(target: ShowTarget) {
  const { selected, select } = useMapView();
  const value = showValue(target);
  return {
    pressed: selected !== null && showValue(selected) === value,
    value,
    open: (opener: HTMLElement) => select(target, opener),
  };
}

/** The props that make a button open an item's details and show it is open. */
export function useShowProps(target: ShowTarget) {
  const { pressed, value, open } = useShowTarget(target);
  return {
    'aria-pressed': pressed,
    'data-show': value,
    onClick: (event: { currentTarget: HTMLElement }) => open(event.currentTarget),
  };
}

export function memberLike(member: MemberConfig): MemberLike {
  return member.kind === 'ai'
    ? {
        handle: member.handle,
        displayName: member.displayName,
        kind: 'ai',
        role: member.role,
        specialty: member.specialty,
      }
    : { handle: member.handle, displayName: member.displayName, kind: 'human', role: member.access };
}
