import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force-3d';
import { styleOf, type Space, type SpaceNode } from './types';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Placed {
  id: string;
  world: Vec3;
  /** Horizontal footprint used by the layout (the shell radius for expanded groups). */
  radius: number;
  /** Radius of the mesh for nodes drawn as a shape (notes, collapsed groups). */
  meshRadius: number;
  /** False when hidden inside a collapsed group. */
  visible: boolean;
  /** Node that represents this one on screen: itself, or the outermost collapsed ancestor. */
  anchorId: string;
  /** Global-level node living inside a group: drawn with a tether instead of stretching the shell. */
  tethered: boolean;
  /** Nesting depth: 0 for root nodes. */
  depth: number;
  /** Product of the fixed-size scale factors of the groups around it (1 = none); shrinks captions. */
  fitScale: number;
}

/** Horizontal torus: ring radius, horizontal and vertical tube radii, height of its centre. */
export interface TorusShape {
  major: number;
  tube: number;
  tubeY: number;
  y: number;
}

export interface Shell {
  id: string;
  /** Present when the group's shell is a torus (the ellipsoid radii still bound it). */
  torus?: TorusShape;
  /** World height of the group's local level 0 (its frame of reference). */
  zeroY: number;
  center: Vec3;
  radii: Vec3;
}

export interface Layout {
  placed: Map<string, Placed>;
  /** Shells of expanded, visible groups. */
  shells: Map<string, Shell>;
  /** Horizontal positions inside the parent frame; feed back in to keep the layout stable. */
  local: Map<string, { x: number; z: number }>;
}

export const NOTE_RADIUS = 2.5;
const SHELL_PADDING = 2.5;
const RING_GAP = 6;

export class SpaceIndex {
  readonly byId = new Map<string, SpaceNode>();
  readonly children = new Map<string | null, SpaceNode[]>();
  private readonly parent = new Map<string, string | null>();

  constructor(readonly space: Space) {
    for (const n of space.nodes) this.byId.set(n.id, n);
    for (const n of space.nodes) {
      const p = this.validParent(n);
      this.parent.set(n.id, p);
      const list = this.children.get(p) ?? [];
      list.push(n);
      this.children.set(p, list);
    }
  }

  parentOf(id: string): string | null {
    return this.parent.get(id) ?? null;
  }

  /** Parent ids from the nearest to the root. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    for (let p = this.parentOf(id); p !== null; p = this.parentOf(p)) out.push(p);
    return out;
  }

  /** True if putting `nodeId` into `newParentId` would nest a group inside itself. */
  wouldCreateCycle(nodeId: string, newParentId: string | null): boolean {
    for (let p = newParentId; p !== null; p = this.parentOf(p)) if (p === nodeId) return true;
    return false;
  }

  private validParent(n: SpaceNode): string | null {
    const p = n.parentId ? this.byId.get(n.parentId) : undefined;
    if (!p || p.kind !== 'group') return null;
    // Broken data with a parent cycle: treat the node as root rather than loop forever.
    const seen = new Set([n.id]);
    for (let cur: SpaceNode | undefined = p; cur; cur = cur.parentId ? this.byId.get(cur.parentId) : undefined) {
      if (seen.has(cur.id)) return null;
      seen.add(cur.id);
    }
    return p.id;
  }
}

export function nodeRadius(space: Space, n: SpaceNode): number {
  return NOTE_RADIUS * styleOf(space, n).size * (n.kind === 'group' ? 1.4 : 1);
}

export function isExpandedGroup(n: SpaceNode): boolean {
  return n.kind === 'group' && !n.frame?.collapsed;
}

export function isTethered(idx: SpaceIndex, n: SpaceNode): boolean {
  return n.levelMode === 'global' && idx.parentOf(n.id) !== null;
}

/**
 * Space a node occupies, relative to its own origin: a horizontally round ellipsoid
 * of radius `r`, vertical half-height `ry`, centred `cy` above the origin.
 * For a plain node it is a sphere (r = ry, cy = 0).
 */
interface Extent {
  r: number;
  ry: number;
  cy: number;
}

interface SimItem {
  id: string;
  r: number;
  /** Vertical centre (relative to the parent origin) and half-height of the item's extent. */
  yc: number;
  ry: number;
  /** Minimal free space to neighbours. */
  gap: number;
  /** Fixed direction on a ring (radians, from +x towards +z), for `aimAt`. */
  angle?: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

/**
 * Nested layout:
 *  1. bottom-up, each group lays out its direct children on the horizontal plane (force layout
 *     or a ring) and fits a shell that fully contains them (including nested shells);
 *     the shell radius is the footprint its parent uses for collisions;
 *  2. top-down, world positions are composed: XZ from parent origin + local XZ,
 *     Y from the level (local frame of the parent group, or the global scale).
 */
export interface LayoutOptions {
  /**
   * Scale applied per nesting level (0..1]: contents of a group are this much smaller than the
   * group's siblings — node sizes, level steps and gaps alike. 1 = no shrinking.
   */
  depthScale?: number;
}

export function computeLayout(space: Space, prev?: Layout, opts: LayoutOptions = {}): Layout {
  const aiming = space.nodes.filter((n) => n.aimAt && n.aimAt !== n.id);
  if (!aiming.length) return layoutPass(space, prev, opts, new Map());
  // Directions depend on where the targets end up, so lay out once, aim, and lay out again.
  const first = layoutPass(space, prev, opts, new Map());
  const angles = new Map<string, number>();
  const idx = new SpaceIndex(space);
  for (const n of aiming) {
    const parent = idx.parentOf(n.id);
    if (!parent || !first.placed.has(n.aimAt!)) continue;
    const from = first.placed.get(parent)!.world;
    const to = attachPoint(first, n.aimAt!);
    if (Math.hypot(to.x - from.x, to.z - from.z) > 1e-6) angles.set(n.id, Math.atan2(to.z - from.z, to.x - from.x));
  }
  return layoutPass(space, first, opts, angles);
}

/** One layout pass; `aim` gives fixed ring angles for nodes with `aimAt`. */
function layoutPass(space: Space, prev: Layout | undefined, opts: LayoutOptions, aim: Map<string, number>): Layout {
  const idx = new SpaceIndex(space);
  const depthScale = opts.depthScale ?? 1;
  const depthOf = (id: string) => idx.ancestors(id).length;
  /** Fixed-size groups: horizontal / vertical factor applied to everything inside them. */
  const fitH = new Map<string, number>();
  const fitV = new Map<string, number>();
  const fitOf = (n: SpaceNode, m: Map<string, number>) => idx.ancestors(n.id).reduce((p, a) => p * (m.get(a) ?? 1), 1);
  /** Size scale of a node: nesting depth and the fixed-size groups around it. */
  const scaleOf = (n: SpaceNode) => depthScale ** depthOf(n.id) * fitOf(n, fitH);
  /** Horizontal scale of everything inside a group (its children's scale); 1 at the root. */
  const inner = (g: SpaceNode | undefined) => (g ? scaleOf(g) * depthScale * (fitH.get(g.id) ?? 1) : 1);
  /** Vertical scale inside a group: like `inner`, but with the vertical fit factors. */
  const innerV = (g: SpaceNode | undefined) =>
    g ? depthScale ** (depthOf(g.id) + 1) * fitOf(g, fitV) * (fitV.get(g.id) ?? 1) : 1;
  /** Shell radii of fixed-size groups. */
  const fixedRadii = new Map<string, Vec3>();
  const local = new Map<string, { x: number; z: number }>();
  /** Own extent of expanded groups, from their contents. */
  const natural = new Map<string, Extent>();
  /** Extent after applying `sizeAs`. */
  const effective = new Map<string, Extent>();
  const inProgress = new Set<string>();
  /** Vertical shift of a group's contents (from `centerOnLevel`). */
  const shift = new Map<string, number>();
  /** Torus parameters of torus-shaped groups; `y` is relative to the group origin. */
  const tori = new Map<string, TorusShape>();
  /** Minimum ring radius for a torus group, set by its parent to nest rings concentrically. */
  const minRing = new Map<string, number>();

  const step = (g: SpaceNode | undefined) => g?.frame?.levelStep ?? space.globalStep;
  const offset = (g: SpaceNode | undefined) => g?.frame?.offset ?? 0;
  /** Y of a non-global child relative to its parent's origin. */
  const localY = (n: SpaceNode, parent: SpaceNode | undefined) => (offset(parent) + n.level * step(parent)) * innerV(parent);
  /** Absolute Y of a node's origin (levels only; independent of horizontal layout). */
  const absY = (n: SpaceNode | undefined): number => {
    if (!n) return 0;
    if (n.levelMode === 'global') return n.level * space.globalStep;
    const p = idx.parentOf(n.id);
    const parent = p ? idx.byId.get(p) : undefined;
    return absY(parent) + localY(n, parent);
  };

  // Direct child of `parentId` that contains `id` (or is `id`).
  const childUnder = (id: string, parentId: string | null): string | null => {
    if (!idx.byId.has(id)) return null;
    let cur = id;
    for (;;) {
      const p = idx.parentOf(cur);
      if (p === parentId) return cur;
      if (p === null) return null;
      cur = p;
    }
  };

  const ownExtent = (n: SpaceNode): Extent => {
    if (isExpandedGroup(n)) return layoutGroup(n.id);
    const r = nodeRadius(space, n) * scaleOf(n);
    return { r, ry: r, cy: 0 };
  };

  const extentOf = (n: SpaceNode): Extent => {
    const cached = effective.get(n.id);
    if (cached) return cached;
    let ext = ownExtent(n);
    const ref = n.sizeAs ? idx.byId.get(n.sizeAs) : undefined;
    // A reference to itself or to a group still being laid out (an ancestor) is ignored.
    if (ref && ref.id !== n.id && !inProgress.has(ref.id)) {
      const re = ownExtent(ref);
      ext = isExpandedGroup(n)
        ? { r: Math.max(ext.r, re.r), ry: Math.max(ext.ry, re.ry), cy: ext.cy }
        : { r: re.r, ry: re.r, cy: 0 };
    }
    effective.set(n.id, ext);
    return ext;
  };

  /** Outer radius of a node's footprint: the ring for torus groups, the extent otherwise. */
  const ringOuter = (n: SpaceNode): number => {
    const r = extentOf(n).r;
    const t = tori.get(n.id);
    return t ? t.major + t.tube : r;
  };

  /** Forgets everything computed inside a group, so it can be laid out again at another scale. */
  const forgetInside = (groupId: string) => {
    for (const n of space.nodes) {
      if (!idx.ancestors(n.id).includes(groupId)) continue;
      for (const m of [natural, effective, local, tori, shift, minRing, fitH, fitV, fixedRadii]) m.delete(n.id);
    }
  };

  /**
   * Lays out a group's children (or the root's, for `null`) and returns the group's extent.
   * A fixed-size group is laid out twice: once at natural scale to measure its contents, then
   * with the contents scaled to fit the fixed shell.
   */
  function layoutGroup(groupId: string | null): Extent {
    const cached = groupId ? natural.get(groupId) : undefined;
    if (cached) return cached;
    const group = groupId ? idx.byId.get(groupId) : undefined;
    const size = group?.frame?.fixedSize;
    if (!group || !size || !isExpandedGroup(group)) return layoutGroupBody(groupId);

    const rx = Math.max(size.x, 0.1) / 2;
    const ry = Math.max(size.y, 0.05) / 2;
    const rz = Math.max(size.z, 0.1) / 2;
    const measured = layoutGroupBody(groupId); // symmetric around level 0 (see `centerMode`)
    const h = Math.min(rx, rz) / Math.max(measured.r, 1e-6);
    // Levels are squeezed into the thickness, but never stretched beyond the horizontal scale.
    const v = Math.min(h, ry / Math.max(measured.ry, 1e-6));
    forgetInside(group.id);
    natural.delete(group.id);
    fitH.set(group.id, h);
    fitV.set(group.id, v);
    layoutGroupBody(groupId);
    const ext = { r: Math.max(rx, rz), ry, cy: 0 };
    fixedRadii.set(group.id, { x: rx, y: ry, z: rz });
    natural.set(group.id, ext);
    return ext;
  }

  /** How a group's shell is centred (fixed-size groups are always centred on level 0). */
  const centerMode = (g: SpaceNode) =>
    g.frame?.fixedSize ? 'zero' : (g.frame?.center ?? (g.frame?.centerOnLevel ? 'shift' : 'content'));

  function layoutGroupBody(groupId: string | null): Extent {
    if (groupId) inProgress.add(groupId);
    const group = groupId ? idx.byId.get(groupId) : undefined;
    const kids = idx.children.get(groupId) ?? [];
    const k = inner(group);
    const ringed = group?.frame?.arrange === 'ring' || group?.frame?.shell === 'torus';

    // Concentric rings: in a ring/torus group, children pinned to the centre that are torus groups
    // ring around whatever pinned stuff precedes them (in order), instead of sharing one radius.
    if (ringed) {
      let hole = 0;
      for (const n of kids) {
        if (!n.pinned || Math.hypot(n.pinned.x, n.pinned.z) > 1e-6) continue;
        if (isExpandedGroup(n) && n.frame?.shell === 'torus') minRing.set(n.id, hole + RING_GAP * k);
        hole = Math.max(hole, ringOuter(n));
      }
    }

    const items: SimItem[] = kids.map((n) => {
      // Collapsed groups still lay out their contents (positions stay stable on expand).
      if (n.kind === 'group' && !isExpandedGroup(n)) layoutGroup(n.id);
      const e = extentOf(n);
      const y = n.levelMode === 'global' ? n.level * space.globalStep - absY(group) : localY(n, group);
      // A centre-pinned torus only occupies its ring, not the ellipsoid that bounds it.
      const r = ringed && n.pinned ? ringOuter(n) : e.r;
      const item: SimItem = { id: n.id, r, yc: y + e.cy, ry: e.ry, gap: 1.5 * k, angle: aim.get(n.id) };
      const start = n.pinned ?? prev?.local.get(n.id);
      if (start) {
        item.x = start.x;
        item.y = start.z;
      }
      if (n.pinned) {
        item.fx = n.pinned.x;
        item.fy = n.pinned.z;
      }
      return item;
    });

    const isTorus = group?.frame?.shell === 'torus';
    if (ringed) placeOnRing(items, RING_GAP * k, groupId ? (minRing.get(groupId) ?? 0) : 0);
    else placeFree(items, groupId, k);
    for (const it of items) local.set(it.id, { x: it.x ?? 0, z: it.y ?? 0 });

    if (groupId) inProgress.delete(groupId);
    if (!group) return { r: 0, ry: 0, cy: 0 };

    // Fit the shell around everything that is not tethered to a global level.
    const samples: { d: number; y: number }[] = [];
    for (const n of kids) {
      if (isTethered(idx, n)) continue;
      const l = local.get(n.id)!;
      const e = extentOf(n);
      const c = Math.hypot(l.x, l.z);
      const y0 = localY(n, group) + e.cy;
      // For each elevation only the point farthest from the group axis matters.
      for (let deg = -90; deg <= 90; deg += 15) {
        const a = (deg * Math.PI) / 180;
        samples.push({ d: c + e.r * Math.cos(a), y: y0 + e.ry * Math.sin(a) });
      }
    }
    // Centred on level 0: mirror the contents vertically, so the fitted shell is symmetric around it.
    if (centerMode(group) === 'zero') for (const p of [...samples]) samples.push({ d: p.d, y: -p.y });
    let ext = samples.length ? fitShell(samples, SHELL_PADDING * k) : { r: NOTE_RADIUS * 2 * k, ry: NOTE_RADIUS * 2 * k, cy: 0 };
    // Torus: tube around the ring of (non-pinned) children; pinned ones stay in the hole.
    const ringKids = items.filter((it) => it.fx === undefined && !isTethered(idx, idx.byId.get(it.id)!));
    let torus: TorusShape | undefined;
    if (isTorus && ringKids.length) {
      const major = ringKids.reduce((s, it) => s + Math.hypot(it.x!, it.y!), 0) / ringKids.length;
      const lo = Math.min(...ringKids.map((it) => it.yc - it.ry));
      const hi = Math.max(...ringKids.map((it) => it.yc + it.ry));
      const pad = SHELL_PADDING * k;
      const tube = Math.max(...ringKids.map((it) => Math.abs(Math.hypot(it.x!, it.y!) - major) + it.r)) + pad;
      torus = { major, tube, tubeY: (hi - lo) / 2 + pad * 0.6, y: (hi + lo) / 2 };
      ext = { r: Math.max(ext.r, major + tube), ry: Math.max(ext.ry, torus.tubeY), cy: ext.cy };
    }
    if (centerMode(group) === 'shift') {
      // Move the contents instead of the shell: its centre lands on the group's own level.
      shift.set(group.id, -ext.cy);
      if (torus) torus = { ...torus, y: torus.y - ext.cy };
      ext = { ...ext, cy: 0 };
    }
    if (torus) tori.set(group.id, torus);
    natural.set(group.id, ext);
    return ext;
  }

  function placeFree(items: SimItem[], parentId: string | null, k: number) {
    if (items.length === 0) return;
    // Links between anything inside two different children pull those children together.
    const pairs = new Map<string, { source: string; target: string }>();
    for (const l of space.links) {
      const a = childUnder(l.from, parentId);
      const b = childUnder(l.to, parentId);
      if (a && b && a !== b) pairs.set(a < b ? `${a}|${b}` : `${b}|${a}`, { source: a, target: b });
    }
    const sim = forceSimulation(items, 2)
      .force('charge', forceManyBody()
        // Equilibrium spacing grows as sqrt(strength), so k² keeps it proportional to the scale.
        .strength(-15 * k * k)
        .distanceMax(40 * k))
      .force('collide', forceCollideByHeight(items))
      .force('x', forceX(0).strength(0.06))
      .force('y', forceY(0).strength(0.06))
      .force(
        'link',
        forceLink([...pairs.values()])
          .id((d: SimItem) => d.id)
          .distance((l: { source: SimItem; target: SimItem }) => clearance(l.source, l.target) + 6 * k)
          .strength(0.2),
      )
      .stop();
    if (items.length > 1) for (let i = 0; i < 300; i++) sim.tick();
    // Final strict pass so that nothing overlaps after the soft forces settle.
    const settle = forceCollideByHeight(items, 1);
    for (let i = 0; i < 30; i++) settle();

    // Keep the frame centred on its contents unless the user pinned something.
    // Centre of the bounding box of the circles, not the mean of the centres: with one big nested
    // group and a few small notes the mean is pulled towards the notes, and the resulting offset
    // would compound through every level of nesting.
    if (!items.some((it) => it.fx !== undefined)) {
      const cx = (Math.min(...items.map((it) => it.x! - it.r)) + Math.max(...items.map((it) => it.x! + it.r))) / 2;
      const cy = (Math.min(...items.map((it) => it.y! - it.r)) + Math.max(...items.map((it) => it.y! + it.r))) / 2;
      for (const it of items) {
        it.x! -= cx;
        it.y! -= cy;
      }
    }
  }

  const root = layoutGroup(null);
  void root;

  const placed = new Map<string, Placed>();
  const shells = new Map<string, Shell>();
  const place = (parent: SpaceNode | undefined, origin: Vec3, visible: boolean, anchorId: string | null, depth: number) => {
    for (const n of idx.children.get(parent?.id ?? null) ?? []) {
      const l = local.get(n.id)!;
      const y =
        n.levelMode === 'global' ? n.level * space.globalStep : origin.y + localY(n, parent) + (parent ? (shift.get(parent.id) ?? 0) : 0);
      const world = { x: origin.x + l.x, y, z: origin.z + l.z };
      const anchor = visible ? n.id : anchorId!;
      const ext = extentOf(n);
      placed.set(n.id, {
        id: n.id,
        world,
        radius: ext.r,
        meshRadius: ext.r * 0.55,
        visible,
        anchorId: anchor,
        tethered: isTethered(idx, n),
        depth,
        fitScale: fitOf(n, fitH),
      });
      if (visible && isExpandedGroup(n)) {
        shells.set(n.id, {
          id: n.id,
          center: { ...world, y: world.y + ext.cy },
          radii: fixedRadii.get(n.id) ?? { x: ext.r, y: ext.ry, z: ext.r },
          zeroY: world.y + offset(n) * innerV(n) + (shift.get(n.id) ?? 0),
          ...(tori.has(n.id) ? { torus: { ...tori.get(n.id)!, y: world.y + tori.get(n.id)!.y } } : {}),
        });
      }
      if (n.kind === 'group') {
        const childVisible = visible && !n.frame?.collapsed;
        place(n, world, childVisible, childVisible ? null : anchor, depth + 1);
      }
    }
  };
  place(undefined, { x: 0, y: 0, z: 0 }, true, null, 0);

  return { placed, shells, local };
}

/** Horizontal half-width of an item's ellipsoid at height `h` (0 outside its vertical range). */
function widthAt(it: SimItem, h: number): number {
  const t = (h - it.yc) / it.ry;
  return t * t >= 1 ? 0 : it.r * Math.sqrt(1 - t * t);
}

/**
 * Horizontal distance two items need between their axes. Items at different heights may stand
 * closer: a note above a nested group only has to clear the group's (narrower) top.
 */
function clearance(a: SimItem, b: SimItem): number {
  const lo = Math.max(a.yc - a.ry, b.yc - b.ry);
  const hi = Math.min(a.yc + a.ry, b.yc + b.ry);
  if (lo >= hi) return 0; // no vertical overlap
  // Height inside the overlap closest to each centre, where each ellipsoid is widest.
  const clamp = (v: number) => Math.min(hi, Math.max(lo, v));
  return widthAt(a, clamp(b.yc)) + widthAt(b, clamp(a.yc)) + Math.max(a.gap, b.gap);
}

/** Collision that respects heights (see `clearance`). Pinned items (fx/fy) are not moved. */
function forceCollideByHeight(items: SimItem[], strength = 0.7) {
  return () => {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const need = clearance(a, b);
        if (need <= 0) continue;
        let dx = b.x! - a.x!;
        let dy = b.y! - a.y!;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 1e-6) {
          // Coincident: separate along a deterministic direction.
          dx = Math.cos(i + j);
          dy = Math.sin(i + j);
          d = 1;
        }
        const push = ((need - d) / d) * strength;
        const aFixed = a.fx !== undefined;
        const bFixed = b.fx !== undefined;
        if (aFixed && bFixed) continue;
        const ka = aFixed ? 0 : bFixed ? 1 : b.r * b.r / (a.r * a.r + b.r * b.r);
        const kb = 1 - ka;
        a.x! -= dx * push * ka;
        a.y! -= dy * push * ka;
        b.x! += dx * push * kb;
        b.y! += dy * push * kb;
      }
    }
  };
}

/** Evenly spaced on a circle around the pinned (usually central) children. */
function placeOnRing(items: SimItem[], gap: number, minInner = 0) {
  const fixed = items.filter((it) => it.fx !== undefined);
  const ring = items.filter((it) => it.fx === undefined);
  for (const it of fixed) {
    it.x = it.fx;
    it.y = it.fy;
  }
  if (ring.length === 0) return;
  const innerR = Math.max(minInner, ...fixed.map((it) => Math.hypot(it.fx!, it.fy!) + it.r));
  const maxR = Math.max(...ring.map((it) => it.r));
  const n = ring.length;
  // Far enough from the centre and with neighbours not overlapping.
  const radius = Math.max(innerR + maxR + gap, n > 1 ? (maxR + gap / 2) / Math.sin(Math.PI / n) : 0);
  ring.forEach((it, i) => {
    const a = it.angle ?? -Math.PI / 2 + (2 * Math.PI * i) / n;
    it.x = radius * Math.cos(a);
    it.y = radius * Math.sin(a);
  });
}

/**
 * Smallest (by vertical cross-section, over a few aspect ratios) horizontally round ellipsoid centred on the
 * group axis that contains all sample points (d = distance from the axis, y = height).
 */
function fitShell(pts: { d: number; y: number }[], pad: number): Extent {
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const cy = (minY + maxY) / 2;
  const h = Math.max((maxY - minY) / 2, 0.5);
  let best: Extent | null = null;
  for (const f of [1.02, 1.05, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5, 1.75, 2, 2.5, 3, 4]) {
    const ry = h * f;
    let r = 0;
    for (const p of pts) {
      const t = (p.y - cy) / ry;
      r = Math.max(r, p.d / Math.sqrt(1 - t * t));
    }
    // Smallest vertical cross-section (r·ry): minimising volume (r²·ry) favours tall, narrow
    // shells, which compound through nesting into elongated outer groups.
    if (!best || r * ry < best.r * best.ry) best = { r, ry, cy };
  }
  return { r: best!.r + pad, ry: best!.ry + pad * 0.6, cy };
}

/** Point where links attach to a node: shell centre for expanded groups, the node position otherwise. */
export function attachPoint(layout: Layout, id: string): Vec3 {
  return layout.shells.get(id)?.center ?? layout.placed.get(id)!.world;
}
