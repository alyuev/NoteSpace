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
  /** Shift the contents so that the shell's centre sits exactly at the group's own level. */
  centerOnLevel?: boolean;
  /** Shell shape. A torus lies horizontally; children are placed along its ring, pinned ones in the hole. */
  shell?: ShellShape;
}

export type ShellShape = 'ellipsoid' | 'torus';

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

/** Appearance actually used for a node: its named style if it has one, otherwise its own. */
export function styleOf(space: Space, n: SpaceNode): NodeStyle {
  return (n.styleId && space.styles?.find((s) => s.id === n.styleId)) || n.style;
}

export function newId(): string {
  return crypto.randomUUID();
}
