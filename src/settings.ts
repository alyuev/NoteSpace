import {
  DEFAULT_DEPTH_SCALE,
  DEFAULT_LABEL_DEPTH_FADE,
  DEFAULT_LABEL_SHRINK,
  DEFAULT_LINK_OPACITY,
  DEFAULT_OBJECT_DEPTH_FADE,
} from './viewer/viewer';

/** Per-user view preferences (not part of a space, not exported). */
export interface ViewSettings {
  /** Brightness of links, 0..1. */
  linkOpacity: number;
  /** Show each group's zero-level ring. */
  showFrames: boolean;
  /** Show the vertical axis through the centre of the space. */
  showAxis: boolean;
  /** How strongly labels far from the camera fade, 0..1. */
  labelDepthFade: number;
  /** Labels grow when the camera comes closer. */
  labelZoom: boolean;
  /** Overall label size multiplier, 0.5..2. */
  labelScale: number;
  /** Label size factor per nesting level, 0.5..1. */
  labelShrink: number;
  /** Size of a group's contents relative to the group's level, per nesting level, 0.4..1. */
  depthScale: number;
  /** How strongly far objects dissolve into the background, 0..1. */
  objectDepthFade: number;
  /** Side panels: width in pixels and whether they are hidden. */
  panels: { left: PanelState; right: PanelState };
}

export interface PanelState {
  width: number;
  collapsed: boolean;
}

const KEY = 'notespace.settings.v1';
const DEFAULTS: ViewSettings = {
  linkOpacity: DEFAULT_LINK_OPACITY,
  showFrames: true,
  showAxis: true,
  labelDepthFade: DEFAULT_LABEL_DEPTH_FADE,
  labelZoom: true,
  labelScale: 1,
  labelShrink: DEFAULT_LABEL_SHRINK,
  depthScale: DEFAULT_DEPTH_SCALE,
  objectDepthFade: DEFAULT_OBJECT_DEPTH_FADE,
  panels: { left: { width: 250, collapsed: false }, right: { width: 320, collapsed: false } },
};

export function loadSettings(): ViewSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<ViewSettings>) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: ViewSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // settings simply won't persist
  }
}
