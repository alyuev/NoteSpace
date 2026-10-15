export const SCHEMA_VERSION = 1;

export type NodeKind = 'group' | 'note';

/**
 * local  — Y is measured in the parent group's frame (moves with the group).
 * global — Y is measured from the scene origin, regardless of the parent.
 */
export type LevelMode = 'local' | 'global';

export type Shape = 'sphere' | 'box' | 'cone' | 'octahedron' | 'torus' | 'cylinder';

export interface NodeStyle {
  color: string;
  shape: Shape;
  /** Size multiplier, 1 = default. */
  size: number;
  /**
   * Several colours: the shape is split into equal coloured sectors (e.g. a spirit expressing
   * both the Father and the Son). When set, `color` is only a fallback.
   */
  colors?: string[];
}

/** Local coordinate frame a group provides to its children. */
export interface GroupFrame {
  /** Shift of the group's zero level relative to the group itself, in scene units. */
  offset: number;
  /** Distance between neighbouring local levels inside the group. */
  levelStep: number;
  collapsed: boolean;
  /** How children are placed horizontally: free (force layout, default) or evenly on a ring. */
  arrange?: Arrange;
  /** @deprecated use `center: 'shift'` (kept for spaces saved before `center` existed). */
  centerOnLevel?: boolean;
  /**
   * Where the shell's centre is:
   *  content — middle of the contents (default);
   *  shift   — at the group's own level, by moving the contents;
   *  zero    — at the group's local level 0: the shell is made symmetric around it, so the
   *            group's position, its zero ring and its geometric centre coincide.
   */
  center?: ShellCenter;
  /**
   * Fixed shell size (diameters: x = east–west, z = north–south, y = thickness). The contents
   * are scaled to fit (horizontally and vertically separately), captions included, so adding
   * things inside does not change the group's size. The centre is at local level 0.
   */
  fixedSize?: { x: number; y: number; z: number };
  /** With a fixed size: share of the shell's width the contents take, 0.05..1 (default 1 = fill it). */
  fill?: number;
  /** Shell shape. A torus lies horizontally; children are placed along its ring, pinned ones in the hole. */
  shell?: ShellShape;
  /** Visibility of the shell, 0..1 (1 = default); contents are not affected. */
  shellOpacity?: number;
}

export type ShellShape = 'ellipsoid' | 'torus';

export type ShellCenter = 'content' | 'shift' | 'zero';

export type Arrange = 'free' | 'ring';

export interface SpaceNode {
  id: string;
  kind: NodeKind;
  /** Must reference a group; anything else is treated as root. */
  parentId: string | null;
  title: string;
  contentHtml: string;
  /** Tag ids. */
  tags: string[];
  levelMode: LevelMode;
  level: number;
  /** Manually fixed horizontal position inside the parent frame ({0,0} = centre of the group). */
  pinned?: { x: number; z: number };
  /** Take the size of another node (a group's size depends on its contents). */
  sizeAs?: string;
  /**
   * In a ring or torus group: place this node on the ring in the direction of another node
   * (from the group's centre towards it) instead of the next free slot.
   */
  aimAt?: string;
  /** Named style of the space; when set it replaces `style`. */
  styleId?: string;
  /** Excluded from publishing/export. */
  private?: boolean;
  style: NodeStyle;
  /** Present for groups only. */
  frame?: GroupFrame;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  label?: string;
  color?: string;
  directed?: boolean;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

/** Reusable appearance, e.g. "Ангелы" or "Сыны Троицы". */
export interface NamedStyle extends NodeStyle {
  id: string;
  name: string;
}

export interface Space {
  id: string;
  schemaVersion: number;
  title: string;
  /** Distance between global levels. */
  globalStep: number;
  nodes: SpaceNode[];
  links: Link[];
  tags: Tag[];
  /** Optional: spaces saved before named styles existed have none. */
  styles?: NamedStyle[];
  /** Node turned towards the viewer when the space is opened. */
  frontNodeId?: string;
  /** Template the space was created from, for "update from template". */
  templateId?: string;
}

/** Average of a style's colours: for captions and highlights of multi-coloured nodes. */
export function blendColors(colors: string[]): string {
  const rgb = colors.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  const avg = [0, 1, 2].map((k) => Math.round(rgb.reduce((s, v) => s + v[k], 0) / rgb.length));
  return '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Single colour representing a style (its blend when it has several). */
export function mainColor(style: NodeStyle): string {
  return style.colors && style.colors.length > 1 ? blendColors(style.colors) : (style.colors?.[0] ?? style.color);
}

/** Appearance actually used for a node: its named style if it has one, otherwise its own. */
export function styleOf(space: Space, n: SpaceNode): NodeStyle {
  return (n.styleId && space.styles?.find((s) => s.id === n.styleId)) || n.style;
}

export function newId(): string {
  return crypto.randomUUID();
}
