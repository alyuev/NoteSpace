import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { matchesFilter, type TagFilter } from '../core/filter';
import { attachPoint, isExpandedGroup, SpaceIndex, type Layout, type Shell, type Vec3 } from '../core/layout';
import { mainColor, styleOf, type Shape, type Space } from '../core/types';

const GEOMETRY: Record<Shape, THREE.BufferGeometry> = {
  sphere: new THREE.SphereGeometry(1, 24, 16),
  box: new THREE.BoxGeometry(1.6, 1.6, 1.6),
  cone: new THREE.ConeGeometry(1, 2, 24),
  octahedron: new THREE.OctahedronGeometry(1.25),
  torus: new THREE.TorusGeometry(1, 0.38, 12, 32),
  cylinder: new THREE.CylinderGeometry(0.9, 0.9, 1.8, 24),
};
const SHELL_GEOMETRY = new THREE.SphereGeometry(1, 40, 24);
const ARROW_GEOMETRY = new THREE.ConeGeometry(0.5, 1.6, 12);
const SHARED = new Set<THREE.BufferGeometry>([...Object.values(GEOMETRY), SHELL_GEOMETRY, ARROW_GEOMETRY]);

const DIM = 0.1;
/** Hover time before an object's description card appears. */
const CARD_DELAY_MS = 500;
/**
 * Picking by apparent size: objects smaller than this on screen (radius, px) are not targets, so
 * from afar the pointer catches a group as a whole rather than the tiny things inside it.
 */
const PICK_NODE_MIN_PX = 4;
const PICK_SHELL_MIN_PX = 30;
/** Share of the pending wheel zoom applied per frame: smaller = smoother, longer glide. */
const ZOOM_EASE = 0.08;
/** Distance (both left and up) from the object to the card's bottom-right corner. */
const CARD_OFFSET_PX = 36;
/** Card sides in order of preference: name, screen x direction, screen y direction (+1 = up). */
const CARD_QUADRANTS: [string, number, number][] = [
  ['ul', -1, 1],
  ['ur', 1, 1],
  ['dl', -1, -1],
  ['dr', 1, -1],
];

export const DEFAULT_LINK_OPACITY = 0.35;
export const DEFAULT_LABEL_DEPTH_FADE = 0.7;
export const DEFAULT_OBJECT_DEPTH_FADE = 0.6;

/** Base label sizes; each nesting level multiplies them by `labelShrink`. */
const LABEL_PX: Record<string, number> = { group: 15, note: 12, link: 10 };
export const DEFAULT_LABEL_SHRINK = 0.7;
export const DEFAULT_DEPTH_SCALE = 0.75;
const MIN_LABEL_PX = 5;
const MAX_LABEL_PX = 28;
/** Object caption height relative to the object's radius (notes) or shell radius (groups). */
const NOTE_LABEL_K = 1.0;
const GROUP_LABEL_K = 0.16;
/** On-screen radius (px) of a group from which its caption starts to rise, and the extra px over which it reaches full lift. */
const GROUP_LIFT_FROM_PX = 60;
const GROUP_LIFT_RAMP_PX = 200;
/** A group's caption sits above the far edge of its shell by this many caption heights (on screen). */
const GROUP_LABEL_LIFT = 0.5;
/** Ring (torus) caption height relative to the tube's thickness. */
const RING_LABEL_K = 0.9;
/** Link caption height relative to the smaller caption of the two linked objects. */
const LINK_LABEL_K = 0.8;
/** Object captions fade out between these on-screen heights (px) instead of shrinking unreadably. */
const LABEL_HIDE_PX = 4;
const LABEL_FULL_PX = 8;

/** normal — no tag filter; strong — both ends match the filter; dim — filtered out. */
type LinkState = 'normal' | 'strong' | 'dim';

function linkOpacityFor(state: LinkState, base: number): number {
  // Highlighted links stay visible even with a low setting, so the filter still reads.
  if (state === 'strong') return Math.max(base, 0.85);
  if (state === 'dim') return Math.min(base, 0.05);
  return base;
}

export interface ViewState {
  filter: TagFilter;
  selectedId: string | null;
}

/** Read-only 3D renderer of a laid-out space. Shared by the editor and (later) the exported viewer. */
export class Viewer {
  onSelect?: (id: string | null) => void;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly labels = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly pickNodes: THREE.Object3D[] = [];
  private readonly pickShells: THREE.Object3D[] = [];
  private focusGoal: THREE.Vector3 | null = null;
  private fitted = false;
  private hoverId: string | null = null;
  /** Wheel zoom still to apply (log scale: + away, − closer) and the point it zooms about. */
  private zoomPending = 0;
  private zoomPoint: THREE.Vector3 | null = null;
  private readonly ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private readonly arcTexts: { label: CSS2DObject; path: SVGPathElement; text: SVGTextElement }[] = [];
  private space: Space | null = null;
  private cardId: string | null = null;
  private cardObj: CSS2DObject | null = null;
  private overCard = false;
  private cardShowTimer = 0;
  private cardHideTimer = 0;
  private layout: Layout | null = null;
  /** Camera position to glide to together with `focusGoal` (fly-to). */
  private cameraGoal: THREE.Vector3 | null = null;
  private linkOpacity = DEFAULT_LINK_OPACITY;
  /** Draw each group's zero-level ring (its frame of reference). Takes effect on the next render. */
  showFrames = true;
  /** Draw the vertical axis through the centre of the space. Takes effect on the next render. */
  showAxis = true;
  private labelDepthFade = DEFAULT_LABEL_DEPTH_FADE;
  private objectDepthFade = DEFAULT_OBJECT_DEPTH_FADE;
  /** Labels grow when the camera comes closer to them. */
  labelZoom = true;
  /** Overall label size multiplier (1 = default). Applied live by the render loop. */
  labelScale = 1;
  /** Label size factor per nesting level. Takes effect on the next render. */
  labelShrink = DEFAULT_LABEL_SHRINK;
  /** Camera distance of the "whole space" view; label sizes are relative to it. */
  private overviewDist = 300;
  private readonly labelObjs: CSS2DObject[] = [];

  constructor(private readonly container: HTMLElement) {
    this.scene.background = new THREE.Color('#16161e');
    this.scene.fog = new THREE.Fog('#16161e', 250, 700);
    this.scene.add(new THREE.AmbientLight('#ffffff', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(60, 120, 80);
    this.scene.add(sun, this.content);

    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.append(this.renderer.domElement);
    this.labels.domElement.className = 'labels';
    container.append(this.labels.domElement);
    // Curved captions of rings (text along the projected ring), drawn under the regular labels.
    this.ringSvg.setAttribute('class', 'ring-labels');
    container.insertBefore(this.ringSvg, this.labels.domElement);

    this.camera.position.set(70, 60, 100);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Wheel zooms towards the point under the cursor, so the camera's focus follows what you look at.
    // Wheel zoom is our own (see `bindSmoothZoom`): OrbitControls applies each wheel step at once.
    this.controls.enableZoom = false;
    this.controls.target.set(0, 15, 0);
    this.controls.addEventListener('start', () => {
      this.focusGoal = null;
      this.cameraGoal = null;
    });

    this.bindPicking();
    this.bindSmoothZoom();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  focus(p: Vec3) {
    this.focusGoal = new THREE.Vector3(p.x, p.y, p.z);
  }

  /**
   * Glides the camera to a node: its centre becomes the pivot of rotation, panning and zoom, and
   * the distance matches its size, so navigation speed suits the object instead of the whole space.
   */
  flyTo(id: string) {
    const layout = this.layout;
    const p = layout?.placed.get(id);
    if (!layout || !p) return;
    const shell = layout.shells.get(id);
    const c = attachPoint(layout, id);
    const size = shell ? Math.max(shell.radii.x, shell.radii.y) : Math.max(p.meshRadius * 6, 2);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (size / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2)) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.focusGoal = new THREE.Vector3(c.x, c.y, c.z);
    this.cameraGoal = this.focusGoal.clone().addScaledVector(dir, dist);
  }

  /** Re-fit the camera on the next render (e.g. after switching spaces). */
  resetView() {
    this.fitted = false;
  }

  /** Point the camera so that everything visible fits into view. */
  fitAll(layout: Layout, front?: Vec3) {
    const box = new THREE.Box3();
    for (const p of layout.placed.values()) if (p.visible) box.expandByPoint(toV(p.world));
    for (const s of layout.shells.values()) {
      box.expandByPoint(toV(s.center).sub(toV(s.radii)));
      box.expandByPoint(toV(s.center).add(toV(s.radii)));
    }
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    // The box's bounding sphere is conservative, so a factor below 1 still keeps everything in view.
    const dist = (sphere.radius / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2)) * 0.7;
    // Moderate elevation: levels (height) still read, and rings of groups are not edge-on.
    const dir = new THREE.Vector3(0.55, 0.5, 0.7).normalize();
    if (front) {
      // Look from the side of the `front` node, so it is the nearest thing to the viewer.
      const h = new THREE.Vector3(front.x - sphere.center.x, 0, front.z - sphere.center.z);
      if (h.lengthSq() > 1e-6) {
        h.normalize();
        dir.set(h.x * 0.8, 0.5, h.z * 0.8).normalize();
      }
    }
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.overviewDist = dist;
    this.focusGoal = null;
  }

  render(space: Space, layout: Layout, view: ViewState) {
    this.layout = layout;
    this.space = space;
    this.clear();
    const idx = new SpaceIndex(space);
    const filtering = view.filter.tagIds.length > 0;

    // A node is lit if it matches; a collapsed group is lit if anything hidden inside it matches.
    const lit = new Set<string>();
    for (const n of space.nodes) if (matchesFilter(n, view.filter)) lit.add(layout.placed.get(n.id)!.anchorId);
    const alpha = (id: string) => (lit.has(id) ? 1 : DIM);

    let minY = 0;
    let maxY = 0;
    let extent = 0;
    for (const n of space.nodes) {
      const p = layout.placed.get(n.id)!;
      if (!p.visible) continue;
      minY = Math.min(minY, p.world.y);
      maxY = Math.max(maxY, p.world.y + p.radius);
      extent = Math.max(extent, Math.hypot(p.world.x, p.world.z) + p.radius);
      const a = alpha(n.id);
      const selected = n.id === view.selectedId;
      const style = styleOf(space, n);
      // Nesting shrinks captions, and so does a fixed-size group squeezing its contents.
      const fontScale = Math.pow(this.labelShrink, p.depth) * p.fitScale;

      if (isExpandedGroup(n)) {
        const shell = layout.shells.get(n.id)!;
        minY = Math.min(minY, shell.center.y - shell.radii.y);
        maxY = Math.max(maxY, shell.center.y + shell.radii.y);
        this.addShell(n.id, mainColor(style), shell, a * (n.frame?.shellOpacity ?? 1), selected);
        // Ring at the group's local zero level: makes its frame of reference visible.
        if (this.showFrames) {
          this.addRing(
            { x: p.world.x, y: shell.zeroY, z: p.world.z },
            Math.min(shell.radii.x, shell.radii.z) * 0.8,
            mainColor(style),
            0.12 * a, // auxiliary guide: keep it faint
          );
        }
        const label = this.addLabel(n.title, { ...shell.center, y: shell.center.y + shell.radii.y }, mainColor(style), a, 'group', fontScale, n.id);
        // Caption height follows the group's size on screen.
        // A ring is a thin tube: its caption follows the tube's thickness, not the ring's radius.
        label.userData.worldSize =
          (shell.torus ? Math.max(shell.torus.tube, shell.torus.tubeY) * RING_LABEL_K : Math.max(shell.radii.x, shell.radii.z) * GROUP_LABEL_K) *
          // Nested groups are often nearly as big as their parents: shrink captions per level too.
          Math.pow(this.labelShrink, p.depth);
        if (!shell.torus) label.userData.groupRadius = Math.max(shell.radii.x, shell.radii.z);
        // Concentric tori share a centre: their captions go onto the ring itself (see `placeRingLabels`).
        if (shell.torus) {
          // Angles of the objects on the ring: the caption goes into a gap between them.
          const members = (idx.children.get(n.id) ?? [])
            .map((c) => layout.placed.get(c.id)!)
            .filter((c) => c.visible && Math.hypot(c.world.x - shell.center.x, c.world.z - shell.center.z) > shell.torus!.major * 0.5)
            .map((c) => Math.atan2(c.world.z - shell.center.z, c.world.x - shell.center.x))
            .sort((a, b) => a - b);
          label.userData.ring = { x: shell.center.x, z: shell.center.z, ...shell.torus, members };
          this.addArcText(label, n.title, mainColor(style));
        }
        continue;
      }

      const hidden = n.kind === 'group' ? countDescendants(idx, n.id) : 0;
      const multi = style.colors && style.colors.length > 1;
      const mesh = new THREE.Mesh(
        multi ? sectorGeometry(style.shape, style.colors!) : GEOMETRY[style.shape],
        new THREE.MeshStandardMaterial({
          // Multi-coloured: vertex colours carry the sectors; the glow is their blend.
          color: multi ? '#ffffff' : style.color,
          vertexColors: !!multi,
          emissive: mainColor(style),
          emissiveIntensity: selected ? 0.9 : filtering && lit.has(n.id) ? 0.6 : 0.15,
          roughness: 0.45,
          transparent: true,
          opacity: a,
        }),
      );
      const scale = p.meshRadius * (selected ? 1.3 : 1);
      mesh.scale.setScalar(scale);
      mesh.position.set(p.world.x, p.world.y, p.world.z);
      mesh.userData.id = n.id;
      if (n.spin) mesh.userData.spin = (n.spin * Math.PI * 2) / 60;
      this.content.add(mesh);
      this.pickNodes.push(mesh);
      const title = hidden ? `${n.title} (+${hidden})` : n.title;
      const label = this.addLabel(title, { ...p.world, y: p.world.y + scale * 1.4 }, mainColor(style), a, n.kind, fontScale, n.id);
      // Caption height follows the object's size on screen.
      // Notes already get smaller with nesting, so their captions just follow their size (the extra
      // per-level shrink is for groups, whose nested shells can be almost as big as their parents).
      label.userData.worldSize = p.meshRadius * NOTE_LABEL_K;

      if (p.tethered) {
        const parent = idx.parentOf(n.id)!;
        const from = attachPoint(layout, layout.placed.get(parent)!.anchorId);
        this.addLine(from, p.world, mainColor(style), 0.45 * a, true);
      }
    }

    for (const l of space.links) {
      const a = layout.placed.get(l.from)?.anchorId;
      const b = layout.placed.get(l.to)?.anchorId;
      if (!a || !b || a === b) continue;
      const p1 = attachPoint(layout, a);
      const p2 = attachPoint(layout, b);
      const state: LinkState = !filtering ? 'normal' : lit.has(a) && lit.has(b) ? 'strong' : 'dim';
      const opacity = linkOpacityFor(state, this.linkOpacity);
      const color = l.color ?? '#c0caf5';
      const parts: THREE.Object3D[] = [this.addLine(p1, p2, color, opacity, false)];
      if (l.directed) parts.push(this.addArrow(p1, p2, color, opacity));
      if (l.label) {
        const caption = this.addLabel(l.label, lerp(p1, p2, 0.5), color, opacity, 'link');
        // As small as the smaller of the two linked objects' captions.
        caption.userData.worldSize = Math.min(this.captionSize(layout, a), this.captionSize(layout, b)) * LINK_LABEL_K;
        parts.push(caption);
      }
      for (const p of parts) p.userData.link = state;
    }

    const gridSize = Math.max(600, Math.ceil((extent * 2.5) / 100) * 100);
    const grid = new THREE.GridHelper(gridSize, gridSize / 10, '#2a2e42', '#20222f');
    grid.position.y = minY - 6;

    // Axes through the origin of the space (the origin node's centre when one is set).
    if (this.showAxis) {
      const h = extent * 1.2;
      const axes: [THREE.Vector3, THREE.Vector3, string][] = [
        [new THREE.Vector3(-h, 0, 0), new THREE.Vector3(h, 0, 0), '#f7768e'],
        [new THREE.Vector3(0, minY - 6, 0), new THREE.Vector3(0, maxY + 10, 0), '#9ece6a'],
        [new THREE.Vector3(0, 0, -h), new THREE.Vector3(0, 0, h), '#7aa2f7'],
      ];
      // Paradise's long (north–south) axis is Z: north on −Z (left in the default view), east on +X.
      const compass: [string, Vec3, string][] = [
        ['Север', { x: 0, y: 0, z: -h }, '#7aa2f7'],
        ['Юг', { x: 0, y: 0, z: h }, '#7aa2f7'],
        ['Запад', { x: -h, y: 0, z: 0 }, '#f7768e'],
        ['Восток', { x: h, y: 0, z: 0 }, '#f7768e'],
      ];
      for (const [text, at, color] of compass) this.addLabel(text, at, color, 1, 'group');
      for (const [from, to, color] of axes) {
        this.content.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([from, to]),
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }),
          ),
        );
      }
    }
    this.content.add(grid);

    if (!this.fitted) {
      this.fitted = true;
      const front = space.frontNodeId && layout.placed.has(space.frontNodeId) ? attachPoint(layout, space.frontNodeId) : undefined;
      this.fitAll(layout, front);
    }

    // The scene was rebuilt: re-apply the highlight of whatever is under the pointer.
    this.applyHover(this.hoverId, true);

    if (this.cardId) this.showCard(this.cardId);
  }

  // ---------- hover card ----------

  /** Shows the description card of a node (replacing any other). */
  private showCard(id: string) {
    this.removeCard();
    const n = this.space?.nodes.find((x) => x.id === id);
    const p = this.layout?.placed.get(id);
    if (!n || !p?.visible || !this.space || !this.layout) return;
    const named = n.styleId ? this.space.styles?.find((s) => s.id === n.styleId) : undefined;
    this.cardObj = this.addCard(n.title, n.contentHtml, attachPoint(this.layout, id), styleOf(this.space, n).color, named?.name);
    this.cardId = id;
  }

  /**
   * Chooses where the card goes, every frame: up-left by default, otherwise the first of
   * up-right / down-left / down-right that fits on screen. For a group the leader points at its
   * shell on that side (not its centre), so the card never covers the group itself.
   */
  private placeCard() {
    const obj = this.cardObj;
    const id = this.cardId;
    if (!obj || !id || !this.layout) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const card = obj.element.querySelector('.card') as HTMLElement;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const shell = this.layout.shells.get(id);
    const center = attachPoint(this.layout, id);
    const camRight = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const camUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    let chosen: { q: string; point: THREE.Vector3 } | null = null;
    for (const [q, sx, sy] of CARD_QUADRANTS) {
      const point = new THREE.Vector3(center.x, center.y, center.z);
      if (shell) {
        // Point of the shell in the chosen screen direction.
        const v = camRight.clone().multiplyScalar(sx).addScaledVector(camUp, sy).normalize();
        const r = shell.radii;
        const t = 1 / Math.sqrt((v.x / r.x) ** 2 + (v.y / r.y) ** 2 + (v.z / r.z) ** 2);
        if (shell.torus) {
          // A ring: point at the ring on that side, not at the shared centre of concentric rings.
          const hdir = new THREE.Vector3(v.x, 0, v.z);
          if (hdir.lengthSq() < 1e-6) hdir.set(camRight.x, 0, camRight.z);
          hdir.normalize();
          point.set(center.x, shell.torus.y, center.z).addScaledVector(hdir, shell.torus.major + shell.torus.tube * 0.9);
        } else point.addScaledVector(v, t * 0.97);
      }
      const s = point.clone().project(this.camera);
      const px = ((s.x + 1) / 2) * rect.width;
      const py = ((1 - s.y) / 2) * rect.height;
      const fitsX = sx < 0 ? px - CARD_OFFSET_PX - w >= 0 : px + CARD_OFFSET_PX + w <= rect.width;
      const fitsY = sy > 0 ? py - CARD_OFFSET_PX - h >= 0 : py + CARD_OFFSET_PX + h <= rect.height;
      if (!chosen) chosen = { q, point }; // fallback: the default side
      if (q === CARD_QUADRANTS[0][0] && !(fitsX && fitsY) && shell) {
        // A group much bigger than the card whose up-left edge is too close to (or past) the view
        // border: keep the preferred side and point the leader at a spot inside the group, at the
        // top-left of the view, rather than jumping to another side.
        const margin = 8;
        const cx = THREE.MathUtils.clamp(px, CARD_OFFSET_PX + w + margin, Math.max(rect.width - margin, CARD_OFFSET_PX + w + margin));
        const cy = THREE.MathUtils.clamp(py, CARD_OFFSET_PX + h + margin, Math.max(rect.height - margin, CARD_OFFSET_PX + h + margin));
        const sc = new THREE.Vector3(center.x, center.y, center.z).project(this.camera);
        const scx = ((sc.x + 1) / 2) * rect.width;
        const scy = ((1 - sc.y) / 2) * rect.height;
        const unit = rect.height / (2 * this.camera.position.distanceTo(toV(center)) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
        const radiusPx = Math.max(shell.radii.x, shell.radii.z) * unit;
        if (radiusPx > Math.max(w, h) && Math.hypot(cx - scx, cy - scy) <= radiusPx * 0.95) {
          chosen = { q, point: new THREE.Vector3((cx / rect.width) * 2 - 1, 1 - (cy / rect.height) * 2, s.z).unproject(this.camera) };
          break;
        }
      }
      if (fitsX && fitsY) {
        chosen = { q, point };
        break;
      }
    }
    obj.position.copy(chosen!.point);
    if (obj.userData.q !== chosen!.q) {
      obj.element.classList.remove(`q-${obj.userData.q}`);
      obj.element.classList.add(`q-${chosen!.q}`);
      obj.userData.q = chosen!.q;
    }
  }

  private removeCard() {
    if (this.cardObj) this.content.remove(this.cardObj);
    this.cardObj = null;
    this.cardId = null;
    this.overCard = false;
  }

  /** Hides the card unless the pointer is on it or back on its object. */
  private hideCardSoon() {
    clearTimeout(this.cardHideTimer);
    this.cardHideTimer = window.setTimeout(() => {
      if (!this.overCard && this.hoverId !== this.cardId) this.removeCard();
    }, 250);
  }

  /** The camera is inside a group's shell: its card would pop up wherever you look, so skip it. */
  private cameraInside(id: string): boolean {
    const shell = this.layout?.shells.get(id);
    if (!shell) return false;
    const c = this.camera.position;
    const { center: o, radii: r } = shell;
    return ((c.x - o.x) / r.x) ** 2 + ((c.y - o.y) / r.y) ** 2 + ((c.z - o.z) / r.z) ** 2 < 1;
  }

  private addShell(id: string, color: string, shell: Shell, a: number, selected: boolean) {
    const { center: c, radii: r, torus } = shell;
    const mesh = new THREE.Mesh(
      torus ? new THREE.TorusGeometry(torus.major, torus.tube, 20, 72) : SHELL_GEOMETRY,
      new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: (selected ? 0.16 : 0.07) * a,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    if (torus) {
      // Lying flat: the geometry's z axis becomes vertical; stretch the tube to its height.
      mesh.rotation.x = Math.PI / 2;
      mesh.scale.set(1, 1, torus.tubeY / torus.tube);
      mesh.position.set(c.x, torus.y, c.z);
    } else {
      mesh.scale.set(r.x, r.y, r.z);
      mesh.position.set(c.x, c.y, c.z);
    }
    mesh.userData.id = id;
    // For picking the innermost of nested shells, and for picking by apparent size.
    mesh.userData.size = r.x * r.y * r.z;
    mesh.userData.radius = Math.max(r.x, r.z);
    mesh.userData.baseOpacity = (mesh.material as THREE.Material).opacity;
    mesh.renderOrder = -1;
    this.content.add(mesh);
    this.pickShells.push(mesh);

    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: (selected ? 0.5 : 0.18) * a });
    let outline: THREE.Object3D;
    if (torus) {
      // Smooth outer and inner edge of the ring (polygon edges of a torus read as a jagged mesh).
      const circle = (radius: number) =>
        new THREE.BufferGeometry().setFromPoints(
          new THREE.EllipseCurve(0, 0, radius, radius).getPoints(96).map((p) => new THREE.Vector3(p.x, 0, p.y)),
        );
      const outer = new THREE.LineLoop(circle(torus.major + torus.tube), material);
      outline = new THREE.LineLoop(circle(Math.max(torus.major - torus.tube, 0.1)), material);
      outline.add(outer);
      outline.position.set(c.x, torus.y, c.z);
    } else {
      outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1, 16, 8), 30), material);
      outline.scale.copy(mesh.scale);
      outline.position.copy(mesh.position);
    }
    outline.userData.outlineOf = id;
    // Both torus circles share this material, so hover highlighting reaches them together.
    outline.userData.baseOpacity = material.opacity;
    this.content.add(outline);
  }

  private addRing(c: Vec3, radius: number, color: string, opacity: number) {
    const pts = new THREE.EllipseCurve(0, 0, radius, radius).getPoints(64).map((v) => new THREE.Vector3(v.x, 0, v.y));
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity }),
    );
    line.computeLineDistances();
    line.position.set(c.x, c.y, c.z);
    this.content.add(line);
  }

  private addLine(p1: Vec3, p2: Vec3, color: string, opacity: number, dashed: boolean) {
    const geo = new THREE.BufferGeometry().setFromPoints([toV(p1), toV(p2)]);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 1, transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const line = new THREE.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    this.content.add(line);
    return line;
  }

  private addArrow(p1: Vec3, p2: Vec3, color: string, opacity: number) {
    const dir = toV(p2).sub(toV(p1)).normalize();
    const cone = new THREE.Mesh(ARROW_GEOMETRY, new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
    cone.position.copy(toV(lerp(p1, p2, 0.6)));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    this.content.add(cone);
    return cone;
  }

  /** Brightness of links, 0..1. Applied in place, without rebuilding the scene. */
  setLinkOpacity(value: number) {
    this.linkOpacity = value;
    for (const obj of this.content.children) {
      const state = obj.userData.link as LinkState | undefined;
      if (!state) continue;
      const opacity = linkOpacityFor(state, value);
      if (obj instanceof CSS2DObject) obj.userData.baseOpacity = Math.max(opacity, 0.12);
      else ((obj as THREE.Mesh).material as THREE.Material).opacity = opacity;
    }
  }

  private addLabel(text: string, at: Vec3, color: string, opacity: number, kind: string, fontScale = 1, forId?: string) {
    const el = document.createElement('div');
    el.className = `label label-${kind}`;
    el.textContent = text;
    el.style.color = color;
    const obj = new CSS2DObject(el);
    obj.position.set(at.x, at.y, at.z);
    obj.center.set(0.5, 1);
    obj.userData.baseOpacity = Math.max(opacity, 0.12);
    obj.userData.basePx = Math.max(MIN_LABEL_PX, (LABEL_PX[kind] ?? 12) * fontScale);
    obj.userData.depthFactor = fontScale;
    if (forId) obj.userData.forId = forId;
    this.content.add(obj);
    this.labelObjs.push(obj);
    this.applyLabelDepth(obj);
    return obj;
  }

  /**
   * Depth effects on a label, measured against the camera-to-target distance (so they work the
   * same at any zoom, and zooming towards an object makes its labels brighter and larger):
   *  - brightness = own opacity (tag filter, link brightness) × fade with distance;
   *  - size = nesting-based size × proximity factor.
   */
  private applyLabelDepth(obj: CSS2DObject, dist = this.camera.position.distanceTo(this.controls.target)) {
    const d = Math.max(this.camera.position.distanceTo(obj.position), 1e-3);
    let fade = 1;
    if (this.labelDepthFade > 0) {
      const t = THREE.MathUtils.clamp((d - dist * 0.6) / dist, 0, 1); // 0 = near, 1 = far
      fade = 1 - this.labelDepthFade * 0.95 * t;
    }
    const hovered = obj.element.classList.contains('hovered');
    let opacity = hovered ? 1 : (obj.userData.baseOpacity as number) * fade;
    let px: number;
    const worldSize = obj.userData.worldSize as number | undefined;
    if (worldSize) {
      // Object captions: as tall as the object looks on screen, so captions of small (deep or
      // squeezed) objects are small and grow together with them when the camera comes closer.
      const pxPerUnit = this.renderer.domElement.clientHeight / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      px = Math.min(MAX_LABEL_PX * this.labelScale, worldSize * pxPerUnit * this.labelScale);
      // Too small to read: fade out instead of piling up into an unreadable blot.
      if (!hovered) opacity *= THREE.MathUtils.clamp((px - LABEL_HIDE_PX) / (LABEL_FULL_PX - LABEL_HIDE_PX), 0, 1);
      px = Math.max(px, LABEL_HIDE_PX);
    } else {
      // Link captions: base size, slightly larger up close.
      const maxZoom = 3 / Math.max((obj.userData.depthFactor as number) ?? 1, 0.05);
      const zoom = this.labelZoom ? THREE.MathUtils.clamp(Math.sqrt(this.overviewDist / d), 0.75, maxZoom) : 1;
      px = Math.min(MAX_LABEL_PX * this.labelScale, (obj.userData.basePx as number) * zoom * this.labelScale);
    }
    // Touch the DOM only when a value visibly changes.
    if (Math.abs(opacity - ((obj.userData.shownOpacity as number | undefined) ?? -1)) > 0.02) {
      obj.userData.shownOpacity = opacity;
      obj.element.style.opacity = opacity.toFixed(2);
    }
    if (Math.abs(px - ((obj.userData.shownPx as number | undefined) ?? -1)) > 0.3) {
      obj.userData.shownPx = px;
      obj.element.style.fontSize = `${px.toFixed(1)}px`;
    }
  }

  /** How strongly far labels fade, 0 (off) .. 1. */
  setLabelDepthFade(value: number) {
    this.labelDepthFade = value;
  }

  /** How strongly far objects dissolve into the background, 0 (off) .. 1. */
  setObjectDepthFade(value: number) {
    this.objectDepthFade = value;
  }

  private addCard(title: string, html: string, at: Vec3, color: string, styleName?: string) {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.setProperty('--card-accent', color);
    const h = document.createElement('h4');
    h.textContent = title;
    if (styleName) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = styleName;
      h.append(badge);
    }
    const close = document.createElement('button');
    close.className = 'card-close';
    close.title = 'Закрыть (Esc)';
    close.textContent = '×';
    close.addEventListener('click', () => this.removeCard());
    el.addEventListener('pointerenter', () => (this.overCard = true));
    el.addEventListener('pointerleave', () => {
      this.overCard = false;
      this.hideCardSoon();
    });
    h.append(close);
    const body = document.createElement('div');
    // Local, user-authored content. Must be sanitised (e.g. DOMPurify) before spaces can be imported/published.
    body.innerHTML = html;
    el.append(h, body);
    // Zero-size anchor at the object; the card sits up and to the left of it, with a leader line
    // from the card's bottom-right corner to the object, so the object itself stays visible.
    const anchor = document.createElement('div');
    anchor.className = 'card-anchor';
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'card-leader');
    svg.setAttribute('width', String(CARD_OFFSET_PX));
    svg.setAttribute('height', String(CARD_OFFSET_PX));
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', String(CARD_OFFSET_PX));
    line.setAttribute('y2', String(CARD_OFFSET_PX));
    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', String(CARD_OFFSET_PX));
    dot.setAttribute('cy', String(CARD_OFFSET_PX));
    dot.setAttribute('r', '3');
    svg.append(line, dot);
    anchor.style.setProperty('--card-accent', color);
    anchor.style.setProperty('--card-offset', `${CARD_OFFSET_PX}px`);
    anchor.append(svg, el);
    const obj = new CSS2DObject(anchor);
    obj.position.set(at.x, at.y, at.z);
    obj.center.set(0, 0);
    this.content.add(obj);
    return obj;
  }

  private clear() {
    for (const obj of [...this.content.children]) {
      this.content.remove(obj); // CSS2DObject removes its DOM element on 'removed'
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry && !SHARED.has(m.geometry)) m.geometry.dispose();
        const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
        for (const mat of mats) mat.dispose();
      });
    }
    this.pickNodes.length = 0;
    this.labelObjs.length = 0;
    this.ringSvg.replaceChildren();
    this.arcTexts.length = 0;
    this.pickShells.length = 0;
  }

  private bindPicking() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const pick = (e: MouseEvent): string | null => {
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      // Nodes win over the group shells that surround them; small nodes get a few pixels of tolerance.
      // Of several shells under the pointer, the innermost (smallest) one: the group you are inside of.
      // Of several shells under the pointer: the innermost one that looks big enough to aim at;
      // if none does, the outermost (the group you can actually see).
      const shellHits = ray.intersectObjects(this.pickShells).sort((a, b) => a.object.userData.size - b.object.userData.size);
      const shellHit = shellHits.find((h) => this.screenRadius(h.object, h.object.userData.radius) >= PICK_SHELL_MIN_PX) ?? shellHits.at(-1);
      // Nodes win over shells, but only once they are big enough on screen to be told apart.
      const nodeHit = ray.intersectObjects(this.pickNodes).find((h) => this.screenRadius(h.object, h.object.scale.x) >= PICK_NODE_MIN_PX);
      const hit = nodeHit ?? this.nearestNode(ndc, rect, 12) ?? shellHit;
      return (hit?.object.userData.id as string | undefined) ?? null;
    };
    // Hover highlight, at most once per frame.
    let hoverEvent: MouseEvent | null = null;
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return; // dragging the view
      if (!hoverEvent)
        requestAnimationFrame(() => {
          if (hoverEvent) this.setHover(pick(hoverEvent));
          hoverEvent = null;
        });
      hoverEvent = e;
    });
    el.addEventListener('pointerleave', () => this.setHover(null));
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !/INPUT|TEXTAREA|SELECT/.test(t.tagName)) {
        this.removeCard();
        this.onSelect?.(null);
      }
    });
    el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    el.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5) {
        const id = pick(e);
        this.onSelect?.(id);
        // Groups become the pivot right away; notes only on double click.
        if (id && this.layout?.shells.has(id)) this.flyTo(id);
      }
      down = null;
    });
    el.addEventListener('dblclick', (e) => {
      const id = pick(e);
      if (id) this.flyTo(id);
    });
  }

  /**
   * Curved caption of a ring: an SVG text along a path that `layoutArcTexts` rebuilds every frame
   * from the front arc of the ring projected onto the screen. The regular label object stays (hidden)
   * as the source of brightness, size and hover state, so all label effects apply.
   */
  private addArcText(label: CSS2DObject, title: string, color: string) {
    const ns = 'http://www.w3.org/2000/svg';
    const id = `arc-${this.arcTexts.length}-${Math.random().toString(36).slice(2, 7)}`;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('id', id);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('class', 'arc-label');
    text.style.fill = color;
    text.style.color = color; // for the hover glow (currentColor)
    const tp = document.createElementNS(ns, 'textPath');
    tp.setAttribute('href', `#${id}`);
    tp.setAttribute('startOffset', '50%');
    tp.setAttribute('text-anchor', 'middle');
    tp.textContent = title;
    text.append(tp);
    this.ringSvg.append(path, text);
    label.element.style.visibility = 'hidden';
    this.arcTexts.push({ label, path, text });
  }

  private layoutArcTexts() {
    if (!this.arcTexts.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cam = this.camera.position;
    const p = new THREE.Vector3();
    for (const { label, path, text } of this.arcTexts) {
      const ring = label.userData.ring as { x: number; z: number; y: number; major: number; tubeY: number; members: number[] };
      const front = gapCentre(Math.atan2(cam.z - ring.z, cam.x - ring.x), ring.members);
      const pts: [number, number][] = [];
      let behind = false;
      // Front arc of ±80°, slightly above the tube so the text sits on the ring.
      for (let i = -16; i <= 16; i++) {
        const a = front + (i / 16) * ((80 * Math.PI) / 180);
        p.set(ring.x + Math.cos(a) * ring.major, ring.y + ring.tubeY, ring.z + Math.sin(a) * ring.major).project(this.camera);
        if (p.z > 1) behind = true;
        pts.push([((p.x + 1) / 2) * rect.width, ((1 - p.y) / 2) * rect.height]);
      }
      if (behind) {
        text.style.display = 'none';
        continue;
      }
      // Text reads left to right whichever way the ring is seen.
      if (pts[0][0] > pts[pts.length - 1][0]) pts.reverse();
      path.setAttribute('d', 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L'));
      const st = label.element.style;
      text.style.display = '';
      text.style.opacity = st.opacity;
      text.style.fontSize = st.fontSize;
      text.classList.toggle('hovered', label.element.classList.contains('hovered'));
    }
  }

  /** World height of a node's caption (see the label sizes in `render`). */
  private captionSize(layout: Layout, id: string): number {
    const p = layout.placed.get(id)!;
    const shell = layout.shells.get(id);
    if (!shell) return p.meshRadius * NOTE_LABEL_K;
    const own = shell.torus ? Math.max(shell.torus.tube, shell.torus.tubeY) * RING_LABEL_K : Math.max(shell.radii.x, shell.radii.z) * GROUP_LABEL_K;
    return own * Math.pow(this.labelShrink, p.depth);
  }

  /** Screen pixels to raise a group's caption so it stands just above the far edge of the group's shell. */
  private groupLabelLift(obj: THREE.Object3D, radius: number, px: number, r: DOMRect, view: DOMRect): number {
    const at = obj.position;
    const cam = this.camera.position;
    const dir = new THREE.Vector3(at.x - cam.x, 0, at.z - cam.z);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize().multiplyScalar(radius);
    const screenY = (v: THREE.Vector3) => view.top + ((1 - v.clone().project(this.camera).y) / 2) * view.height;
    const far = screenY(at.clone().add(dir));
    let lift = Math.max(0, screenY(at) - far) + px * GROUP_LABEL_LIFT;
    lift = Math.min(lift, r.top - view.top - 4); // never above the top of the view
    // Only when zooming in: a group that is small on screen keeps its caption where it was.
    const size = this.screenRadius(obj, radius);
    const k = THREE.MathUtils.clamp((size - GROUP_LIFT_FROM_PX) / GROUP_LIFT_RAMP_PX, 0, 1);
    return Math.max(0, lift) * k;
  }

  /**
   * Keeps object captions from overlapping on screen: larger captions (parents) stay put, a smaller one that
   * would cover an already placed caption is moved just below it. Runs every frame after the label
   * renderer, which resets the position of each caption.
   */
  private separateLabels() {
    const items: { el: HTMLElement; px: number; lift: number; r: DOMRect }[] = [];
    const view = this.renderer.domElement.getBoundingClientRect();
    for (const obj of this.labelObjs) {
      if (obj.userData.link || obj.userData.ring) continue; // link and ring captions have their own placement
      const el = obj.element;
      if (el.style.display === 'none' || parseFloat(el.style.opacity || '1') < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const px = parseFloat(el.style.fontSize) || r.height;
      // A group's caption rides on the far (upper on screen) edge of its shell, clear of the contents;
      // when that edge is off screen it stays at the top of the view.
      let lift = 0;
      const radius = obj.userData.groupRadius as number | undefined;
      if (radius) lift = this.groupLabelLift(obj, radius, px, r, view);
      items.push({ el, px, lift, r: new DOMRect(r.left, r.top - lift, r.width, r.height) });
    }
    items.sort((a, b) => b.px - a.px);
    const placed: { left: number; right: number; top: number; bottom: number }[] = [];
    const GAP = 2;
    for (const it of items) {
      const box = { left: it.r.left, right: it.r.right, top: it.r.top, bottom: it.r.bottom };
      for (let pass = 0; pass < 12; pass++) {
        const hit = placed.find((q) => box.left < q.right && box.right > q.left && box.top < q.bottom && box.bottom > q.top);
        if (!hit) break;
        const dy = hit.bottom + GAP - box.top;
        box.top += dy;
        box.bottom += dy;
      }
      const shift = box.top - it.r.top - it.lift;
      if (shift) it.el.style.transform += ` translateY(${shift}px)`;
      placed.push(box);
    }
  }

  /** Puts each torus caption on its ring, at the point nearest to the viewer (every frame). */
  private placeRingLabels() {
    const cam = this.camera.position;
    for (const obj of this.labelObjs) {
      const ring = obj.userData.ring as { x: number; z: number; y: number; major: number; tube: number; tubeY: number } | undefined;
      if (!ring) continue;
      let dx = cam.x - ring.x;
      let dz = cam.z - ring.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        dx = 0;
        dz = 1;
      } else {
        dx /= len;
        dz /= len;
      }
      obj.position.set(ring.x + dx * ring.major, ring.y + ring.tubeY, ring.z + dz * ring.major);
    }
  }

  /** Emphasises the object under the pointer (brighter node / shell) and shows a pointer cursor. */
  private setHover(id: string | null) {
    if (id === this.hoverId) return;
    this.applyHover(this.hoverId, false);
    this.hoverId = id;
    this.applyHover(id, true);
    this.renderer.domElement.style.cursor = id ? 'pointer' : '';
    // Card after a short dwell; moving away hides it (unless the pointer went onto the card).
    clearTimeout(this.cardShowTimer);
    if (this.cardId && this.cardId !== id) this.hideCardSoon();
    if (id && id !== this.cardId && !this.cameraInside(id)) {
      this.cardShowTimer = window.setTimeout(() => {
        if (this.hoverId === id) this.showCard(id);
      }, CARD_DELAY_MS);
    }
  }

  private applyHover(id: string | null, on: boolean) {
    if (!id) return;
    for (const obj of this.labelObjs) if (obj.userData.forId === id) obj.element.classList.toggle('hovered', on);
    for (const obj of this.content.children) {
      const mesh = obj as THREE.Mesh;
      if (obj.userData.id === id && this.pickNodes.includes(obj)) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        obj.userData.baseEmissive ??= m.emissiveIntensity;
        m.emissiveIntensity = on ? Math.max(0.8, obj.userData.baseEmissive + 0.5) : obj.userData.baseEmissive;
        obj.scale.multiplyScalar(on ? 1.15 : 1 / 1.15);
      } else if (obj.userData.id === id || obj.userData.outlineOf === id) {
        const m = mesh.material as THREE.Material;
        const boost = obj.userData.outlineOf ? 2.5 : 2.2;
        m.opacity = on ? Math.min(1, obj.userData.baseOpacity * boost) : obj.userData.baseOpacity;
      }
    }
  }

  /** Closest-to-camera node whose centre is within `px` screen pixels of the pointer. */
  private nearestNode(ndc: THREE.Vector2, rect: DOMRect, px: number): { object: THREE.Object3D } | undefined {
    let best: { object: THREE.Object3D; depth: number } | undefined;
    for (const obj of this.pickNodes) {
      if (this.screenRadius(obj, obj.scale.x) < PICK_NODE_MIN_PX) continue; // a dot from here
      const s = obj.position.clone().project(this.camera);
      if (s.z > 1) continue; // behind the camera
      const dx = ((s.x - ndc.x) * rect.width) / 2;
      const dy = ((s.y - ndc.y) * rect.height) / 2;
      if (Math.hypot(dx, dy) <= px && (!best || s.z < best.depth)) best = { object: obj, depth: s.z };
    }
    return best;
  }

  /** Apparent radius in screen pixels of something of world radius `r` at `obj`'s position. */
  private screenRadius(obj: THREE.Object3D, r: number): number {
    const d = Math.max(this.camera.position.distanceTo(obj.position), 1e-3);
    return (r * this.renderer.domElement.clientHeight) / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  /**
   * Smooth wheel zoom towards the point under the cursor: wheel steps add up into a pending zoom,
   * which the render loop applies a fraction at a time (eased, like the damped rotation).
   */
  private bindSmoothZoom() {
    const el = this.renderer.domElement;
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.focusGoal = null;
        this.cameraGoal = null;
        // Normalise wheel units (lines / pages / pixels); one notch ≈ 100 px ≈ 15 % closer or farther.
        const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
        this.zoomPending += THREE.MathUtils.clamp(px, -400, 400) * 0.0015;
        // Zoom towards the point under the cursor, on the plane through the focus point facing the camera.
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        const normal = this.camera.getWorldDirection(new THREE.Vector3());
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.controls.target);
        this.zoomPoint = ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.controls.target.clone();
      },
      { passive: false },
    );
  }

  /** Applies a share of the pending wheel zoom (called every frame). */
  private stepZoom() {
    if (Math.abs(this.zoomPending) < 1e-4 || !this.zoomPoint) {
      this.zoomPending = 0;
      return;
    }
    // Small share per frame: a long, soft glide (≈ 1 s to settle at 60 fps).
    const step = this.zoomPending * ZOOM_EASE;
    this.zoomPending -= step;
    const factor = Math.exp(step); // > 1: away, < 1: closer
    const p = this.zoomPoint;
    // Scale camera and focus about the point under the cursor, so that point stays put on screen.
    const newCam = this.camera.position.clone().sub(p).multiplyScalar(factor).add(p);
    const newTarget = this.controls.target.clone().sub(p).multiplyScalar(factor).add(p);
    if (newCam.distanceTo(newTarget) < 0.05) return; // do not pass through the focus point
    this.camera.position.copy(newCam);
    this.controls.target.copy(newTarget);
  }

  private lastFrame = performance.now();

  private frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    for (const obj of this.pickNodes) if (obj.userData.spin) obj.rotation.y += obj.userData.spin * dt;
    this.stepZoom();
    if (this.focusGoal) {
      const delta = this.focusGoal.clone().sub(this.controls.target).multiplyScalar(0.12);
      this.controls.target.add(delta);
      if (this.cameraGoal) {
        const cd = this.cameraGoal.clone().sub(this.camera.position).multiplyScalar(0.12);
        this.camera.position.add(cd);
        if (delta.length() < 0.01 && cd.length() < 0.01) this.focusGoal = this.cameraGoal = null;
      } else {
        this.camera.position.add(delta);
        if (delta.length() < 0.01) this.focusGoal = null;
      }
    }
    this.controls.update();
    // Fog follows the zoom, so objects dissolve relative to the point the camera looks at:
    // with full strength fading starts a bit in front of it and ends not far behind it.
    const fog = this.scene.fog as THREE.Fog;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const k = this.objectDepthFade;
    // Large finite values when off: the fog shader does not handle Infinity.
    fog.near = k > 0 ? dist * (1.3 - 0.8 * k) : 1e9;
    fog.far = k > 0 ? fog.near + dist * (2.6 - 2 * k) : 2e9;
    this.renderer.render(this.scene, this.camera);
    // Fade reference: the nearer of the focus point and the closest labels, so that when the camera
    // is close to something, labels far behind it fade even if the focus point stayed elsewhere.
    let nearest = Infinity;
    for (const obj of this.labelObjs) {
      if (obj.userData.link) continue; // link captions sit between objects, not on them
      nearest = Math.min(nearest, this.camera.position.distanceTo(obj.position));
    }
    const ref = Math.min(dist, Math.max(nearest * 3, 1e-3));
    this.placeRingLabels();
    this.layoutArcTexts();
    for (const obj of this.labelObjs) this.applyLabelDepth(obj, ref);
    this.labels.render(this.scene, this.camera);
    this.separateLabels();
    // The label renderer orders elements by depth; the card must stay above every caption.
    if (this.cardObj) {
      this.placeCard();
      this.cardObj.element.style.zIndex = '1000000';
    }
  }
}

/**
 * Shape geometry split into equal coloured sectors around its vertical axis (cached per
 * shape + colours). Vertices are coloured by their angle, so sector borders follow the mesh.
 */
const sectorCache = new Map<string, THREE.BufferGeometry>();
function sectorGeometry(shape: Shape, colors: string[]): THREE.BufferGeometry {
  const key = `${shape}|${colors.join(',')}`;
  const cached = sectorCache.get(key);
  if (cached) return cached;
  // Non-indexed, so that vertices on a border are not shared between two sectors.
  const geo = GEOMETRY[shape].toNonIndexed();
  const pos = geo.attributes.position;
  const rgb = colors.map((c) => new THREE.Color(c));
  const out = new Float32Array(pos.count * 3);
  const n = colors.length;
  // Each triangle takes the sector of its centre, so borders are clean edges.
  for (let i = 0; i < pos.count; i += 3) {
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      cx += pos.getX(i + k);
      // Shapes lying in the XY plane (torus) are split around their own axis.
      cz += shape === 'torus' ? pos.getY(i + k) : pos.getZ(i + k);
    }
    const angle = (Math.atan2(cz, cx) + 2 * Math.PI) % (2 * Math.PI);
    const c = rgb[Math.min(n - 1, Math.floor((angle / (2 * Math.PI)) * n))];
    for (let k = 0; k < 3; k++) out.set([c.r, c.g, c.b], (i + k) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  SHARED.add(geo);
  sectorCache.set(key, geo);
  return geo;
}

/** Middle of the gap between sorted `members` angles that contains `angle` (or `angle` itself). */
function gapCentre(angle: number, members: number[]): number {
  if (members.length < 2) return members.length === 1 ? members[0] + Math.PI : angle;
  const TAU = 2 * Math.PI;
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const a = norm(angle);
  const ms = members.map(norm).sort((x, y) => x - y);
  for (let i = 0; i < ms.length; i++) {
    const from = ms[i];
    const to = i + 1 < ms.length ? ms[i + 1] : ms[0] + TAU;
    const at = a < from ? a + TAU : a;
    if (at >= from && at <= to) return (from + to) / 2;
  }
  return angle;
}

function countDescendants(idx: SpaceIndex, id: string): number {
  let n = 0;
  for (const c of idx.children.get(id) ?? []) n += 1 + countDescendants(idx, c.id);
  return n;
}

function toV(p: Vec3) {
  return new THREE.Vector3(p.x, p.y, p.z);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
