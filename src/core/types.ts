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
  /**
   * Picture file name (in `data/images/`). When set, the node is drawn as this picture, always
   * facing the viewer, instead of the shape.
   */
  image?: string;
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
  /**
   * Torus only: width of the ring band as a share of what it encloses (its inner radius), e.g.
   * 0.25 = a quarter of it. Absent or 0: the ring just fits its members. Lets a ring be a wide,
   * flat zone even with nothing on it.
   */
  ringWidth?: number;
  /** With `ringWidth`: thickness of the ring as a share of its width (default 0.24 = flat band, 1 = round section). */
  ringThickness?: number;
  /** Torus: width of the ring band in light years (needs `Space.lightYearsPerUnit`); overrides `ringWidth`. */
  ringWidthLy?: number;
  /** Torus pinned in a ring group: distance from the previous ring (or what it encloses) in light years. */
  ringGapLy?: number;
  /**
   * Ring and ring-arranged groups: north–south to east–west ratio (e.g. 7/6 like Paradise). Members
   * on the ring and the shell are stretched along Z (north–south). Absent: round.
   */
  ringAspect?: number;
  /** `wedges` with a fixed size: share of the disc radius left empty in the middle (default 0.25). */
  wedgeInner?: number;
  /** `cells`: how the slice is divided. */
  cells?: {
    /** Number of cells (default 100; older spaces give it as rings × slices). */
    count?: number;
    rings?: number;
    slices?: number;
    /** Numbering starts at the outer ring (default) or at the inner one. */
    from?: 'outer' | 'inner';
  };
  /**
   * The group is as big as a note of this size would be (e.g. a planet among other planets); its
   * contents are scaled to fit inside.
   */
  noteSize?: number;
  /**
   * `drop` shell: a body of revolution starting in a point at the group's position and widening
   * upwards (or downwards) into a rounded end — e.g. a reservoir of unpervaded space above or below
   * Paradise. Sizes in scene units: `height` along the axis, `radius` the widest part.
   */
  drop?: { dir: 'up' | 'down'; height: number; radius: number };
  /** Brightness of the shell's edge lines relative to the default (1 = default, 0.2 = much dimmer). */
  edgeOpacity?: number;
  /** Visibility of the shell, 0..1 (1 = default); contents are not affected. */
  shellOpacity?: number;
}

export type ShellShape = 'ellipsoid' | 'sphere' | 'torus' | 'wedge' | 'drop';

export type ShellCenter = 'content' | 'shift' | 'zero';

/**
 * free   — force layout;
 * ring   — evenly on a ring, pinned ones in the centre;
 * wedges — pinned ones in the centre, the rest as equal slices of a disc around them (children with
 *          the `wedge` shell are drawn as these slices, so together they tile the disc). With a fixed
 *          size the slices are laid out from it alone (`wedgeInner`), not from their contents;
 *          each slice gets a fixed size so its contents are scaled to fit it.
 * cells  — the group is itself a `wedge` slice; it is divided into `cells.count` nearly square cells of
 *          equal area (rings of equal thickness, more cells per ring towards the edge of the disc). The
 *          middle cell is kept for children without a cell number (the capital); a child with `cell`
 *          = n sits in cell n (numbered ring by ring from the outer edge), scaled to fit.
 */
export type Arrange = 'free' | 'ring' | 'wedges' | 'cells';

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
  /**
   * Manually fixed horizontal position inside the parent frame ({0,0} = centre of the group), in
   * the group's own units: it shrinks with the nesting level together with the sizes of nodes.
   */
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
  /** In a ring or torus group: fixed angle on the ring, degrees (0 = east, 90 = south); otherwise the next free slot. */
  ringAngle?: number;
  /** In a `cells` group: number (from 1) of the cell this child occupies. */
  cell?: number;
  /**
   * Always noticeable (e.g. a final destination deep inside): a dot of fixed screen size marks it
   * from any distance, it can be pointed at from afar, and its caption stays readable.
   */
  beacon?: boolean;
  /**
   * The beacon works only on some scales: while the view (camera to focus) is no wider than about the
   * size of group `beaconTo`, and/or no narrower than the size of group `beaconFrom`.
   */
  beaconTo?: string;
  beaconFrom?: string;
  /** Does not react to the mouse (no highlight, no card): the pointer goes through to what is around it. */
  passive?: boolean;
  /** English title and description (the usual fields hold the Russian ones). */
  en?: { title?: string; contentHtml?: string };
  /** Caption brightness multiplier (1 = as usual). */
  labelOpacity?: number;
  /** Caption size multiplier for this object (1 = default): to make an important object stand out. */
  labelScale?: number;
  /** Do not draw the title next to the object (the description card still appears on hover). */
  hideLabel?: boolean;
  /** Spins about the vertical axis, revolutions per minute (0 or absent: still). */
  spin?: number;
  /**
   * Revolves about its parent's centre, seen from above (north up): clockwise or counter-clockwise.
   * Arrows along its ring (a torus) or orbit show the direction; the rotation animation moves it.
   */
  orbit?: 'cw' | 'ccw';
  /** Turns about its own vertical axis during the rotation animation. */
  axial?: 'cw' | 'ccw';
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
  /** English name. */
  en?: string;
}

/** Reusable appearance, e.g. "Ангелы" or "Сыны Троицы". */
export interface NamedStyle extends NodeStyle {
  id: string;
  name: string;
  /** English name. */
  en?: string;
}

export interface Space {
  /** English title of the space. */
  en?: { title?: string };
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
  /** Node whose centre becomes the world origin; the whole layout is shifted together. */
  originNodeId?: string;
  /**
   * Scale for sizes given in light years (`ringWidthLy`, `ringGapLy`): how many light years one
   * scene unit stands for.
   */
  lightYearsPerUnit?: number;
  /**
   * Picture of a galaxy laid into the plane of the space at its real size: the Sun's place in it
   * coincides with node `anchorId`, and the galaxy's centre lies towards node `towardId`.
   */
  galaxy?: {
    anchorId: string;
    towardId: string;
    /** Real size: the galaxy's centre then lies `sunDistanceLy` from the anchor, towards `towardId`. */
    diameterLy?: number;
    sunDistanceLy?: number;
    /** Without `diameterLy`: centre on `towardId`, radius = distance to the anchor x `rimK` (default 1.1). */
    rimK?: number;
    title?: string;
    en?: string;
  };
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
