import * as THREE from 'three';
import { imageUrl } from '../storage';
import { nodeContent, nodeTitle, styleName, tr } from '../i18n';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { matchesFilter, type TagFilter } from '../core/filter';
import { attachPoint, isExpandedGroup, SpaceIndex, type Layout, type Shell, type Vec3 } from '../core/layout';
import { mainColor, styleOf, type Shape, type Space, type SpaceNode } from '../core/types';

const GEOMETRY: Record<Shape, THREE.BufferGeometry> = {
  sphere: new THREE.SphereGeometry(1, 24, 16),
  box: new THREE.BoxGeometry(1.6, 1.6, 1.6),
  cone: new THREE.ConeGeometry(1, 2, 24),
  octahedron: new THREE.OctahedronGeometry(1.25),
  torus: new THREE.TorusGeometry(1, 0.38, 12, 32),
  cylinder: new THREE.CylinderGeometry(0.9, 0.9, 1.8, 24),
};
const SHELL_GEOMETRY = new THREE.SphereGeometry(1, 40, 24);
/** Finer sphere for shells with a picture wrapped on them. */
const WRAP_GEOMETRY = new THREE.SphereGeometry(1, 96, 64);
const ARROW_GEOMETRY = new THREE.ConeGeometry(0.5, 1.6, 12);
const SHARED = new Set<THREE.BufferGeometry>([...Object.values(GEOMETRY), SHELL_GEOMETRY, WRAP_GEOMETRY, ARROW_GEOMETRY]);

/** Height of a picture node relative to the radius of a solid shape. */
const SPRITE_HEIGHT_K = 2.4;

/** Share of the remaining distance covered per frame when the camera flies to an object (smaller = slower). */
const FLY_EASE = 0.025;
/** A flight to an object first climbs out to the overview when the camera is closer than this share of the overview distance. */
const FLY_VIA_CENTRE_BELOW = 0.6;

const DIM = 0.1;
/** Hover time before an object's description card appears. */
const CARD_DELAY_MS = 500;
/** After any change (input, data, resize) full frames keep coming this long: damping, card timers. */
const ACTIVE_GRACE_MS = 1200;
/** Spinning objects smaller than this on screen (pixels across) are not animated. */
const MIN_SPIN_PX = 6;
/** A level enters the list once the view is no wider than this many of its radii. */
const CRUMB_SCALE_K = 3;
/** Wheel zoom stops at this many times the distance to (and size of) the nearest object at the focus. */
const ZOOM_FLOOR_K = 3;
/** The wheel aims at things no farther than this many view widths away. */
const ZOOM_REACH_K = 4;
/** Beacons: dot size, caption size at least, and up to which on-screen radius the dot is what gets picked. */
const BEACON_PX = 5;
const BEACON_LABEL_PX = 11;
/** A beacon's caption fades with distance, but not below this. */
const BEACON_MIN_FADE = 0.5;
/** A beacon range named by a group: up to this many of its radii of view width. */
const BEACON_RANGE_K = 2;
const BEACON_PICK_UNTIL_PX = 25;
/** Closest the camera may come to its focus point: tiny, so that zooming can go as deep as the data does. */
const MIN_VIEW_DIST = 1e-12;
/** Smallest on-screen radius (pixels) at which a slice or cell of a disc can be picked. */
const WEDGE_PICK_MIN_PX = 3;
/** Opacity of the grid lines of cells (the dimmest lines in the scene). */
const CELL_GRID_OPACITY = 0.05;
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
/** A group that fills the view keeps its caption readable: from this on-screen radius (px) the caption has a minimum size, reached at the second value. */
const GROUP_MIN_LABEL_FROM_PX = 100;
const GROUP_MIN_LABEL_FULL_PX = 300;
const GROUP_MIN_LABEL_PX = 14;
const GROUP_LIFT_RAMP_PX = 200;
/** A group's caption sits above the far edge of its shell by this many caption heights (on screen). */
const GROUP_LABEL_LIFT = 0.5;
/** Ring (torus) caption height relative to the tube's thickness. */
const RING_LABEL_K = 0.9;
/** Share of the distance to the nearest concentric ring that a ring's caption may take. */
const RING_ROOM_K = 0.55;
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
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  private readonly labels = new CSS2DRenderer();
  private readonly controls: OrbitControls;
  private readonly content = new THREE.Group();
  private readonly pickNodes: THREE.Object3D[] = [];
  private readonly pickShells: THREE.Object3D[] = [];
  /** Markers of `beacon` nodes: fixed-size dots, pickable from any distance. */
  private readonly beacons: THREE.Object3D[] = [];
  private focusGoal: THREE.Vector3 | null = null;
  private fitted = false;
  private hoverId: string | null = null;
  /** Wheel zoom still to apply (log scale: + away, − closer) and the point it zooms about. */
  private zoomPending = 0;
  private zoomPoint: THREE.Vector3 | null = null;
  /** Closest the wheel may bring the camera to `zoomPoint`. */
  private zoomLimit = 0;
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
  /** Stages of a flight still to go after the current one (see `flyTo`). */
  private flyQueue: { focus: THREE.Vector3; camera: THREE.Vector3 }[] = [];
  /** Group whose description card appears when the current flight gets close to it. */
  private arrival: { id: string; dist: number } | null = null;
  private linkOpacity = DEFAULT_LINK_OPACITY;
  /** Draw each group's zero-level ring (its frame of reference). Takes effect on the next render. */
  showFrames = true;
  /** Draw the vertical axis through the centre of the space. Takes effect on the next render. */
  showAxis = true;
  /** Draw link lines (and their captions). Takes effect on the next render. */
  showLinks = false;
  /** Draw the floor grid under the space. Takes effect on the next render. */
  showGrid = false;
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
    for (const [text, x, z, color] of [
      [tr('С'), 0, -1, '#7aa2f7'],
      [tr('Ю'), 0, 1, '#7aa2f7'],
      [tr('З'), -1, 0, '#f7768e'],
      [tr('В'), 1, 0, '#f7768e'],
    ] as [string, number, number, string][]) {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = `position:absolute;left:0;top:0;display:none;pointer-events:none;z-index:5;font:700 18px sans-serif;color:${color};text-shadow:0 0 4px #000,0 0 2px #000;transform:translate(-50%,-50%)`;
      container.append(el);
      this.edgeCompass.push({ el, dir: new THREE.Vector3(x, 0, z) });
    }
    // Under the search box (.stage-search: top 10px, left 10px, width min(320px, 55%)).
    this.crumbs.style.cssText =
      'position:absolute;top:52px;left:10px;display:none;z-index:6;max-width:min(320px, 55%);max-height:calc(100% - 64px);overflow:auto;' +
      'padding:6px 8px;border-radius:6px;background:rgba(22,22,30,0.72);font:13px sans-serif;';
    container.append(this.crumbs);
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
      this.cancelFlight();
      // Rotating or panning ends a wheel zoom still gliding: it would keep moving the pivot.
      this.zoomPending = 0;
    });
    // Frames are drawn on demand: any input or camera movement wakes the loop for a while.
    this.controls.addEventListener('change', () => {
      this.invalidate();
      this.saveCameraSoon();
    });
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'click'])
      window.addEventListener(type, () => this.invalidate(), { capture: true, passive: true });

    this.bindPicking();
    this.bindSmoothZoom();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Draw full frames (scene and labels) for a while: something visible may have changed. */
  invalidate(ms = ACTIVE_GRACE_MS) {
    this.activeUntil = Math.max(this.activeUntil, performance.now() + ms);
  }

  focus(p: Vec3) {
    this.focusGoal = new THREE.Vector3(p.x, p.y, p.z);
  }

  /**
   * Glides the camera to a node: its centre becomes the pivot of rotation, panning and zoom, and
   * the distance matches its size, so navigation speed suits the object instead of the whole space.
   */
  private cancelFlight() {
    this.focusGoal = null;
    this.cameraGoal = null;
    this.flyQueue.length = 0;
    this.arrival = null;
  }

  /** `viaCentre`: when deep inside something, climb out to the overview first (for jumps to far-away objects, e.g. from search). */
  flyTo(id: string, viaCentre = false) {
    const layout = this.layout;
    const p = layout?.placed.get(id);
    if (!layout || !p) return;
    const shell = layout.shells.get(id);
    const c = attachPoint(layout, id);
    const size = shell ? Math.max(shell.radii.x, shell.radii.y) : p.meshRadius * 6;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (size / Math.sin(Math.min(fov, fov * this.camera.aspect) / 2)) * 1.1;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const dir = offset.clone().normalize();
    const finalFocus = new THREE.Vector3(c.x, c.y, c.z);
    const finalCamera = finalFocus.clone().addScaledVector(dir, dist);
    this.flyQueue.length = 0;
    this.arrival = shell ? { id, dist } : null; // a group: show its description on approach
    this.removeCard(); // the previous object's card must not hang around during the flight
    if (viaCentre && offset.length() < this.overviewDist * FLY_VIA_CENTRE_BELOW) {
      // Deep inside something: first climb out to the overview of the whole space (looking at its
      // centre), then dive to the target, instead of cutting straight through everything.
      const centre = new THREE.Vector3(0, 0, 0);
      this.focusGoal = centre;
      this.cameraGoal = centre.clone().addScaledVector(dir, this.overviewDist);
      this.flyQueue.push({ focus: finalFocus, camera: finalCamera });
    } else {
      this.focusGoal = finalFocus;
      this.cameraGoal = finalCamera;
    }
  }

  /** Re-fit the camera on the next render (e.g. after switching spaces). */
  resetView() {
    this.fitted = false;
    this.ignoreSavedCamera = true;
  }

  /** The camera is remembered per space, so a reload of the page (or a dropped dev-server connection) keeps the view. */
  private ignoreSavedCamera = false;
  private cameraSaveTimer = 0;

  private cameraKey(spaceId: string) {
    return `notespace.camera.${spaceId}`;
  }

  private saveCameraSoon() {
    clearTimeout(this.cameraSaveTimer);
    this.cameraSaveTimer = window.setTimeout(() => {
      if (!this.space || !this.fitted) return;
      const v = (p: THREE.Vector3) => [p.x, p.y, p.z];
      try {
        localStorage.setItem(
          this.cameraKey(this.space.id),
          JSON.stringify({ p: v(this.camera.position), t: v(this.controls.target), o: this.overviewDist }),
        );
      } catch {
        // storage unavailable (private window, quota): the view just is not remembered
      }
    }, 400);
  }

  /** Puts the camera where it was last left in this space; false when nothing usable is saved. */
  private restoreCamera(spaceId: string): boolean {
    try {
      const raw = localStorage.getItem(this.cameraKey(spaceId));
      if (!raw) return false;
      const c = JSON.parse(raw) as { p: number[]; t: number[]; o: number };
      const ok = (a: unknown): a is number[] => Array.isArray(a) && a.length === 3 && a.every((x) => Number.isFinite(x));
      if (!ok(c.p) || !ok(c.t) || !Number.isFinite(c.o) || c.o <= 0) return false;
      this.camera.position.set(c.p[0], c.p[1], c.p[2]);
      this.controls.target.set(c.t[0], c.t[1], c.t[2]);
      this.overviewDist = c.o;
      this.cancelFlight();
      this.controls.update();
      return true;
    } catch {
      return false;
    }
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
    this.cancelFlight();
  }

  render(space: Space, layout: Layout, view: ViewState) {
    this.invalidate();
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
        this.addShell(n.id, mainColor(style), shell, a * (n.frame?.shellOpacity ?? 1), selected, n.frame?.edgeOpacity ?? 1, !n.passive, style.image);
        if (n.beacon) this.addBeacon(n.id, shell.center, Math.max(shell.radii.x, shell.radii.z), mainColor(style), this.beaconRange(n, layout));
        // Ring at the group's local zero level: makes its frame of reference visible.
        if (this.showFrames) {
          this.addRing(
            { x: p.world.x, y: shell.zeroY, z: p.world.z },
            shell.radii.x * 0.8,
            mainColor(style),
            0.12 * a, // auxiliary guide: keep it faint
            shell.radii.z / shell.radii.x,
          );
        }
        if (!n.hideLabel) {
          // A drop is captioned over its middle; other shells above their top.
          const capY = shell.drop ? shell.center.y : shell.center.y + shell.radii.y;
          const label = this.addLabel(nodeTitle(n), { ...shell.center, y: capY }, mainColor(style), a * (n.labelOpacity ?? 1), 'group', fontScale, n.id);
          if (n.beacon) label.userData.beacon = true;
          // Caption height follows the group's size on screen.
          // A ring is a thin tube: its caption follows the tube's thickness, not the ring's radius,
          // but may take the free room up to the neighbouring concentric rings.
          label.userData.worldSize = (n.labelScale ?? 1) * (shell.torus
            ? Math.max(Math.max(shell.torus.tube, shell.torus.tubeY) * RING_LABEL_K * Math.pow(this.labelShrink, p.depth), ringRoom(layout, idx, n.id) * RING_ROOM_K)
            : // Nested groups are often nearly as big as their parents: shrink captions per level too.
              Math.max(shell.radii.x, shell.radii.z) * GROUP_LABEL_K * Math.pow(this.labelShrink, p.depth));
          if (!shell.torus && !shell.drop) {
            label.userData.groupRadius = Math.max(shell.radii.x, shell.radii.z);
            label.userData.shell = shell;
            label.userData.groupCenter = new THREE.Vector3(shell.center.x, shell.center.y, shell.center.z);
          }
          // A drop: the caption runs along its surface, on the front arc of its widest circle.
          if (shell.drop) {
            const d = shell.drop;
            const prof = dropProfile(d.height, d.radius);
            const widest = prof.reduce((b, q) => (q.x > b.x ? q : b), prof[0]);
            const y = d.base.y + (d.dir === 'down' ? -widest.y : widest.y);
            label.userData.shell = shell;
            label.userData.ring = { x: d.base.x, z: d.base.z, y, major: widest.x, tube: 0, tubeY: 0, members: [] };
            this.addArcText(label, nodeTitle(n), mainColor(style));
          }
          // Concentric tori share a centre: their captions go onto the ring itself (see `placeRingLabels`).
          if (shell.torus) {
            // Angles of the objects on the ring: the caption goes into a gap between them.
            const members = (idx.children.get(n.id) ?? [])
              .map((c) => layout.placed.get(c.id)!)
              .filter((c) => c.visible && Math.hypot(c.world.x - shell.center.x, c.world.z - shell.center.z) > shell.torus!.major * 0.5)
              .map((c) => Math.atan2(c.world.z - shell.center.z, c.world.x - shell.center.x))
              .sort((a, b) => a - b);
            label.userData.ring = { x: shell.center.x, z: shell.center.z, ...shell.torus, members };
            this.addArcText(label, nodeTitle(n), mainColor(style));
          }
        }
        continue;
      }

      const hidden = n.kind === 'group' ? countDescendants(idx, n.id) : 0;
      const multi = style.colors && style.colors.length > 1;
      const mesh: THREE.Object3D = style.image
        ? this.makeSprite(style.image, a)
        : new THREE.Mesh(
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
      if (mesh instanceof THREE.Sprite) {
        // A picture: a bit larger than the solid shapes, whose radius is `scale`.
        const height = scale * SPRITE_HEIGHT_K;
        mesh.scale.set(height * (mesh.userData.aspect as number), height, 1);
      } else mesh.scale.setScalar(scale);
      mesh.position.set(p.world.x, p.world.y, p.world.z);
      mesh.userData.id = n.id;
      if (n.beacon) this.addBeacon(n.id, p.world, scale, mainColor(style), this.beaconRange(n, layout));
      if (n.spin) mesh.userData.spin = (n.spin * Math.PI * 2) / 60;
      this.content.add(mesh);
      this.pickNodes.push(mesh);
      if (!n.hideLabel) {
        const title = hidden ? `${nodeTitle(n)} (+${hidden})` : nodeTitle(n);
        const label = this.addLabel(title, { ...p.world, y: p.world.y + scale * 1.4 }, mainColor(style), a * (n.labelOpacity ?? 1), n.kind, fontScale, n.id);
        if (n.beacon) label.userData.beacon = true;
        // Caption height follows the object's size on screen.
        // Notes already get smaller with nesting, so their captions just follow their size (the extra
        // per-level shrink is for groups, whose nested shells can be almost as big as their parents).
        label.userData.worldSize = p.meshRadius * NOTE_LABEL_K * (n.labelScale ?? 1);
      }

      if (p.tethered) {
        const parent = idx.parentOf(n.id)!;
        const from = attachPoint(layout, layout.placed.get(parent)!.anchorId);
        this.addLine(from, p.world, mainColor(style), 0.45 * a, true);
      }
    }

    for (const l of this.showLinks ? space.links : []) {
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
    const grid = new THREE.GridHelper(gridSize, Math.min(gridSize / 10, 400), '#2a2e42', '#20222f');
    grid.position.y = minY - 6;

    // Axes through the origin of the space (the origin node's centre when one is set).
    this.axisLen = 0;
    if (this.showAxis) {
      const h = extent * 1.2;
      this.axisLen = h;
      const axes: [THREE.Vector3, THREE.Vector3, string][] = [
        [new THREE.Vector3(-h, 0, 0), new THREE.Vector3(h, 0, 0), '#f7768e'],
        [new THREE.Vector3(0, minY - 6, 0), new THREE.Vector3(0, maxY + 10, 0), '#9ece6a'],
        [new THREE.Vector3(0, 0, -h), new THREE.Vector3(0, 0, h), '#7aa2f7'],
      ];
      // Paradise's long (north–south) axis is Z: north on −Z (left in the default view), east on +X.
      const compass: [string, Vec3, string][] = [
        [tr('Север'), { x: 0, y: 0, z: -h }, '#7aa2f7'],
        [tr('Юг'), { x: 0, y: 0, z: h }, '#7aa2f7'],
        [tr('Запад'), { x: -h, y: 0, z: 0 }, '#f7768e'],
        [tr('Восток'), { x: h, y: 0, z: 0 }, '#f7768e'],
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
    if (this.showGrid) this.content.add(grid);

    if (!this.fitted) {
      this.fitted = true;
      const useSaved = !this.ignoreSavedCamera;
      this.ignoreSavedCamera = false;
      if (!(useSaved && this.restoreCamera(space.id))) {
        const front = space.frontNodeId && layout.placed.has(space.frontNodeId) ? attachPoint(layout, space.frontNodeId) : undefined;
        this.fitAll(layout, front);
      }
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
    this.cardObj = this.addCard(nodeTitle(n), nodeContent(n), attachPoint(this.layout, id), styleOf(this.space, n).color, named && styleName(named));
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
    let chosen: { q: string; point: THREE.Vector3 } | null = null;
    for (const [q, sx, sy] of CARD_QUADRANTS) {
      const point = new THREE.Vector3(center.x, center.y, center.z);
      if (shell) point.copy(this.shellEdgeToward(shell, sx, sy, rect));
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

  /**
   * Point of a shell's outline that lies furthest in a screen direction (sx right, sy up), found on
   * screen: a 3D direction would pass through the thin axis of a flat shell and land near its centre.
   * A ring uses its outer edge; an ellipsoid its horizontal outline and its top and bottom.
   */
  private shellEdgeToward(shell: Shell, sx: number, sy: number, rect: DOMRect): THREE.Vector3 {
    const { center: c, radii: r, torus, wedge } = shell;
    const pts: THREE.Vector3[] = [];
    const n = 48;
    if (wedge) {
      // Corners and arcs of the slice at its top face.
      for (let i = 0; i <= 12; i++) {
        const a = wedge.a0 + ((wedge.a1 - wedge.a0) * i) / 12;
        for (const rad of [wedge.r0, wedge.r1]) pts.push(new THREE.Vector3(wedge.cx + Math.cos(a) * rad, c.y, wedge.cz + Math.sin(a) * rad));
      }
    }
    for (let i = 0; i < (wedge ? 0 : n); i++) {
      const a = (i / n) * Math.PI * 2;
      if (torus) {
        const R = torus.major + torus.tube * 0.9;
        pts.push(new THREE.Vector3(c.x + Math.cos(a) * R, torus.y, c.z + Math.sin(a) * R * (torus.aspect ?? 1)));
      } else pts.push(new THREE.Vector3(c.x + Math.cos(a) * r.x * 0.97, c.y, c.z + Math.sin(a) * r.z * 0.97));
    }
    if (!torus && !wedge) pts.push(new THREE.Vector3(c.x, c.y + r.y * 0.97, c.z), new THREE.Vector3(c.x, c.y - r.y * 0.97, c.z));
    let best = pts[0];
    let bestScore = -Infinity;
    const p = new THREE.Vector3();
    for (const pt of pts) {
      p.copy(pt).project(this.camera);
      if (p.z > 1) continue; // behind the camera
      const score = sx * p.x * rect.width + sy * p.y * rect.height;
      if (score > bestScore) {
        bestScore = score;
        best = pt;
      }
    }
    return best.clone();
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

  private addShell(id: string, color: string, shell: Shell, a: number, selected: boolean, edge = 1, pickable = true, image?: string) {
    const { center: c, radii: r, torus, wedge } = shell;
    // A slice is built around its own centre (small numbers for the GPU), not around the disc's centre.
    const wedgeMid = wedge ? wedgeCentre(wedge) : null;
    const wedgeGeo = wedge ? wedgeGeometry(wedge, r.y * 2, wedgeMid!) : null;
    const drop = shell.drop;
    const dropGeo = drop ? new THREE.LatheGeometry(dropProfile(drop.height, drop.radius), 64) : null;
    // A picture on a round shell (e.g. a map on a planet): wrapped around it, seen only from outside,
    // so that from inside the contents stay visible.
    const wrapped = image && !torus && !wedge && !drop;
    const mesh = new THREE.Mesh(
      wedgeGeo ?? dropGeo ?? (torus ? new THREE.TorusGeometry(torus.major, torus.tube, 20, 72) : wrapped ? WRAP_GEOMETRY : SHELL_GEOMETRY),
      wrapped
        ? new THREE.MeshStandardMaterial({ map: this.picture(image).texture, transparent: a < 1, opacity: a, side: THREE.FrontSide, roughness: 0.9 })
        : new THREE.MeshStandardMaterial({
            color,
            transparent: true,
            opacity: (selected ? 0.16 : 0.07) * a,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
    );
    if (drop) {
      // Built pointing up from its point; a downward drop is the same turned over.
      mesh.position.set(drop.base.x, drop.base.y, drop.base.z);
      if (drop.dir === 'down') mesh.scale.y = -1;
    } else if (wedge) {
      // The slice is built flat in XY and extruded along z: lay it down, top at the shell's top.
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(wedge.cx + wedgeMid!.x, c.y + r.y, wedge.cz + wedgeMid!.y);
    } else if (torus) {
      // Lying flat: the geometry's z axis becomes vertical; stretch the tube to its height.
      mesh.rotation.x = Math.PI / 2;
      mesh.scale.set(1, torus.aspect ?? 1, torus.tubeY / torus.tube);
      mesh.position.set(c.x, torus.y, c.z);
    } else {
      mesh.scale.set(r.x, r.y, r.z);
      mesh.position.set(c.x, c.y, c.z);
    }
    mesh.userData.id = id;
    // For picking the innermost of nested shells, and for picking by apparent size.
    mesh.userData.size = r.x * r.y * r.z;
    mesh.userData.radius = Math.max(r.x, r.z);
    mesh.userData.shell = shell;
    // Slices and cells tile their parent: nothing else is under the pointer there, so they may be aimed at when small.
    if (wedge) {
      mesh.userData.pickMinPx = WEDGE_PICK_MIN_PX;
      mesh.userData.pickCenter = new THREE.Vector3(c.x, c.y, c.z);
    }
    mesh.userData.baseOpacity = (mesh.material as THREE.Material).opacity;
    mesh.renderOrder = -1;
    this.content.add(mesh);
    if (pickable) this.pickShells.push(mesh);

    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: (selected ? 0.5 : 0.18) * a * edge });
    let outline: THREE.Object3D;
    if (drop) {
      // A few meridians and the widest circle: a smooth outline instead of the mesh's edges.
      outline = new THREE.Group();
      const prof = dropProfile(drop.height, drop.radius);
      for (let m = 0; m < 4; m++) {
        const a = (m * Math.PI) / 4;
        const pts = [...prof.map((p) => new THREE.Vector3(p.x * Math.cos(a), p.y, p.x * Math.sin(a)))];
        const back = [...prof].reverse().map((p) => new THREE.Vector3(-p.x * Math.cos(a), p.y, -p.x * Math.sin(a)));
        outline.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([...pts, ...back]), material));
      }
      const widest = prof.reduce((b, p) => (p.x > b.x ? p : b), prof[0]);
      outline.add(
        new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            new THREE.EllipseCurve(0, 0, widest.x, widest.x).getPoints(96).map((p) => new THREE.Vector3(p.x, widest.y, p.y)),
          ),
          material,
        ),
      );
      outline.position.copy(mesh.position);
      outline.scale.copy(mesh.scale);
    } else if (wedgeGeo) {
      outline = new THREE.LineSegments(new THREE.EdgesGeometry(wedgeGeo, 30), material);
      outline.rotation.copy(mesh.rotation);
      outline.position.copy(mesh.position);
    } else if (torus) {
      // Smooth outer and inner edge of the ring (polygon edges of a torus read as a jagged mesh).
      const circle = (radius: number) =>
        new THREE.BufferGeometry().setFromPoints(
          new THREE.EllipseCurve(0, 0, radius, radius * (torus.aspect ?? 1)).getPoints(96).map((p) => new THREE.Vector3(p.x, 0, p.y)),
        );
      const outer = new THREE.LineLoop(circle(torus.major + torus.tube), material);
      outline = new THREE.LineLoop(circle(Math.max(torus.major - torus.tube, torus.major * 0.01)), material);
      outline.add(outer);
      outline.position.set(c.x, torus.y, c.z);
    } else {
      outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1, 16, 8), 30), material);
      outline.scale.copy(mesh.scale);
      outline.position.copy(mesh.position);
    }
    if (shell.wedge && shell.cells) this.addCellGrid(shell, color, a);
    outline.userData.outlineOf = id;
    // Both torus circles share this material, so hover highlighting reaches them together.
    outline.userData.baseOpacity = material.opacity;
    this.content.add(outline);
  }

  /** Grid lines of the cells a slice is divided into (rings, each split into its own number of cells); always very dim. */
  private addCellGrid(shell: Shell, color: string, a: number) {
    const w = shell.wedge!;
    const y = shell.center.y;
    const mid = wedgeCentre(w);
    const pts: THREE.Vector3[] = [];
    // Points relative to the slice's middle (see `wedgeGeometry`); the object is placed there.
    const at = (r: number, ang: number, h: number) => new THREE.Vector3(Math.cos(ang) * r - mid.x, h, Math.sin(ang) * r - mid.y);
    const arc = (r: number, h: number, steps: number) => {
      for (let i = 0; i < steps; i++) pts.push(at(r, w.a0 + ((w.a1 - w.a0) * i) / steps, h), at(r, w.a0 + ((w.a1 - w.a0) * (i + 1)) / steps, h));
    };
    const layers = shell.cells!.layers;
    layers.forEach((layer, l) => {
      const { bounds, counts } = layer;
      const steps = Math.max(8, Math.max(...counts) * 3);
      // Each layer's cells as boxes: rings and dividers on its bottom face, and on the top of the topmost.
      for (const h of l === layers.length - 1 ? [layer.y - layer.ry, layer.y + layer.ry] : [layer.y - layer.ry]) {
        for (let j = l === 0 && h === layer.y - layer.ry ? 1 : 0; j < bounds.length; j++) {
          if ((j === 0 || j === bounds.length - 1) && (l === 0 && h === layer.y - layer.ry)) continue;
          if ((j === 0 || j === bounds.length - 1) && l === layers.length - 1 && h === layer.y + layer.ry) continue;
          arc(bounds[j], h, steps);
        }
      }
      counts.forEach((n, j) => {
        for (let k = 1; k < n; k++) {
          const ang = w.a0 + ((w.a1 - w.a0) * k) / n;
          // The divider as a rectangle across the layer's height.
          const b0 = at(bounds[j], ang, layer.y - layer.ry);
          const b1 = at(bounds[j + 1], ang, layer.y - layer.ry);
          const t0 = at(bounds[j], ang, layer.y + layer.ry);
          const t1 = at(bounds[j + 1], ang, layer.y + layer.ry);
          pts.push(b0, b1, t0, t1, b0, t0, b1, t1);
        }
      });
    });
    const grid = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      // The denser the grid, the dimmer its lines (100 cells: the base brightness).
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: CELL_GRID_OPACITY * a * Math.min(1, Math.sqrt(100 / Math.max(1, layers.reduce((s, l) => s + l.counts.reduce((x, y) => x + y, 0), 0)))) * (layers.length > 3 ? 0.6 : 1), depthWrite: false }),
    );
    grid.position.set(w.cx + mid.x, y, w.cz + mid.y);
    this.content.add(grid);
  }

  private addRing(c: Vec3, radius: number, color: string, opacity: number, aspect = 1) {
    const pts = new THREE.EllipseCurve(0, 0, radius, radius * aspect).getPoints(64).map((v) => new THREE.Vector3(v.x, 0, v.y));
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity }),
    );
    line.computeLineDistances();
    line.position.set(c.x, c.y, c.z);
    this.content.add(line);
  }

  private addLine(p1: Vec3, p2: Vec3, color: string, opacity: number, dashed: boolean) {
    // Relative to the start point: a link between tiny far-away objects keeps full precision.
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), toV(p2).sub(toV(p1))]);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, dashSize: 1, gapSize: 1, transparent: true, opacity })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    const line = new THREE.Line(geo, mat);
    line.position.copy(toV(p1));
    if (dashed) line.computeLineDistances();
    this.content.add(line);
    return line;
  }

  /** Textures of style pictures by file name; shared by all nodes using them. */
  private readonly pictures = new Map<string, { texture: THREE.Texture; aspect: number; ready: boolean; waiting: THREE.Sprite[] }>();

  /** A node drawn as a picture that always faces the viewer. Its width follows the picture once loaded. */
  /** A picture from `data/images`, loaded once and shared. */
  private picture(image: string) {
    let pic = this.pictures.get(image);
    if (!pic) {
      const entry: { texture: THREE.Texture; aspect: number; ready: boolean; waiting: THREE.Sprite[] } = {
        texture: new THREE.Texture(),
        aspect: 1,
        ready: false,
        waiting: [],
      };
      entry.texture = new THREE.TextureLoader().load(imageUrl(image), (t) => {
        const { width, height } = t.image as { width: number; height: number };
        if (width > 0 && height > 0) entry.aspect = width / height;
        entry.ready = true;
        for (const sp of entry.waiting) sp.scale.x = sp.scale.y * entry.aspect;
        entry.waiting.length = 0;
        this.invalidate();
      });
      entry.texture.colorSpace = THREE.SRGBColorSpace;
      this.pictures.set(image, entry);
      pic = entry;
    }
    return pic;
  }

  private makeSprite(image: string, opacity: number): THREE.Sprite {
    const pic = this.picture(image);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: pic.texture, transparent: true, opacity }));
    sprite.userData.aspect = pic.aspect;
    if (!pic.ready) pic.waiting.push(sprite);
    return sprite;
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
    const d = Math.max(this.camera.position.distanceTo(obj.position), MIN_VIEW_DIST);
    let fade = 1;
    if (this.labelDepthFade > 0) {
      const t = THREE.MathUtils.clamp((d - dist * 0.6) / dist, 0, 1); // 0 = near, 1 = far
      fade = 1 - this.labelDepthFade * 0.95 * t;
    }
    // A group that fills the view: its caption must stay readable however deeply it is nested.
    let floorK = 0;
    const gc = obj.userData.groupCenter as THREE.Vector3 | undefined;
    const sh = obj.userData.shell as Shell | undefined;
    // Inside a group its caption would hang in front of everything: the breadcrumbs name it instead.
    if (sh && insideShell(sh, this.camera.position)) {
      if (obj.userData.shownOpacity !== 0) {
        obj.userData.shownOpacity = 0;
        obj.element.style.opacity = '0';
      }
      return;
    }
    // Only the group being looked into keeps a readable caption; others fade with distance like the rest.
    if (gc && (!sh || insideShell(sh, this.controls.target))) {
      const dc = Math.max(this.camera.position.distanceTo(gc), MIN_VIEW_DIST);
      const radiusPx =
        ((obj.userData.groupRadius as number) * this.renderer.domElement.clientHeight) / (2 * dc * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      floorK = THREE.MathUtils.clamp((radiusPx - GROUP_MIN_LABEL_FROM_PX) / (GROUP_MIN_LABEL_FULL_PX - GROUP_MIN_LABEL_FROM_PX), 0, 1);
      fade += (1 - fade) * floorK; // the caption sits on the far edge, but the group is right here
    }
    const hovered = obj.element.classList.contains('hovered');
    // A beacon's caption does not fade with distance.
    const beaconOn = !!obj.userData.beacon && this.beacons.some((b) => b.userData.id === obj.userData.forId && b.visible);
    if (beaconOn) fade = Math.max(fade, BEACON_MIN_FADE);
    let opacity = hovered ? 1 : (obj.userData.baseOpacity as number) * fade;
    let px: number;
    const worldSize = obj.userData.worldSize as number | undefined;
    if (worldSize) {
      // Object captions: as tall as the object looks on screen, so captions of small (deep or
      // squeezed) objects are small and grow together with them when the camera comes closer.
      const pxPerUnit = this.renderer.domElement.clientHeight / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
      px = Math.min(MAX_LABEL_PX * this.labelScale, worldSize * pxPerUnit * this.labelScale);
      px = Math.max(px, GROUP_MIN_LABEL_PX * floorK * this.labelScale);
      if (beaconOn) px = Math.max(px, BEACON_LABEL_PX * this.labelScale);
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
    close.title = tr('Закрыть (Esc)');
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
    this.beacons.length = 0;
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
      const shellHit =
        shellHits.find((h) => this.screenRadius(h.object, h.object.userData.radius) >= ((h.object.userData.pickMinPx as number | undefined) ?? PICK_SHELL_MIN_PX)) ??
        shellHits.at(-1);
      // Nodes win over shells, but only once they are big enough on screen to be told apart.
      const nodeHit = ray.intersectObjects(this.pickNodes).find((h) => this.screenRadius(h.object, h.object.scale.x) >= PICK_NODE_MIN_PX);
      const hit = nodeHit ?? this.nearestBeacon(ndc, rect, 14) ?? this.nearestNode(ndc, rect, 12) ?? shellHit;
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
      const ring = label.userData.ring as { x: number; z: number; y: number; major: number; tubeY: number; aspect?: number; members: number[] };
      const front = gapCentre(Math.atan2(cam.z - ring.z, cam.x - ring.x), ring.members);
      const pts: [number, number][] = [];
      let behind = false;
      // Front arc of ±80°, slightly above the tube so the text sits on the ring.
      for (let i = -16; i <= 16; i++) {
        const a = front + (i / 16) * ((80 * Math.PI) / 180);
        p.set(ring.x + Math.cos(a) * ring.major, ring.y + ring.tubeY, ring.z + Math.sin(a) * ring.major * (ring.aspect ?? 1)).project(this.camera);
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
      const ring = obj.userData.ring as { x: number; z: number; y: number; major: number; tube: number; tubeY: number; aspect?: number } | undefined;
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
      obj.position.set(ring.x + dx * ring.major, ring.y + ring.tubeY, ring.z + dz * ring.major * (ring.aspect ?? 1));
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
        this.invalidate();
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
        if ('emissiveIntensity' in m) {
          obj.userData.baseEmissive ??= m.emissiveIntensity;
          m.emissiveIntensity = on ? Math.max(0.8, obj.userData.baseEmissive + 0.5) : obj.userData.baseEmissive;
        }
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

  /** A beacon within `px` of the pointer, while its object is still small on screen (up close the object itself is picked). */
  private nearestBeacon(ndc: THREE.Vector2, rect: DOMRect, px: number): { object: THREE.Object3D } | undefined {
    let best: { object: THREE.Object3D; depth: number } | undefined;
    for (const obj of this.beacons) {
      if (!obj.visible || this.screenRadius(obj, obj.userData.radius as number) > BEACON_PICK_UNTIL_PX) continue;
      const s = obj.position.clone().project(this.camera);
      if (s.z > 1) continue;
      const dx = ((s.x - ndc.x) * rect.width) / 2;
      const dy = ((s.y - ndc.y) * rect.height) / 2;
      if (Math.hypot(dx, dy) <= px && (!best || s.z < best.depth)) best = { object: obj, depth: s.z };
    }
    return best;
  }

  /** A dot of fixed screen size marking a `beacon` node, so it can be seen and pointed at from afar. */
  /** View widths (camera to focus) in which a beacon works, from the sizes of the groups it names. */
  private beaconRange(n: SpaceNode, layout: Layout): [number, number] {
    const size = (id?: string) => {
      const sh = id ? layout.shells.get(id) : undefined;
      return sh ? Math.max(sh.radii.x, sh.radii.z) * BEACON_RANGE_K : undefined;
    };
    return [size(n.beaconFrom) ?? 0, size(n.beaconTo) ?? Infinity];
  }

  /** Shows the beacons that work at the current view width; hidden ones are neither seen nor picked. */
  private updateBeacons() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    for (const dot of this.beacons) {
      const [lo, hi] = dot.userData.range as [number, number];
      dot.visible = dist >= lo && dist <= hi;
    }
  }

  private addBeacon(id: string, at: Vec3, radius: number, color: string, range: [number, number] = [0, Infinity]) {
    const dot = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0)]),
      new THREE.PointsMaterial({ color, size: BEACON_PX, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    dot.position.set(at.x, at.y, at.z);
    dot.renderOrder = 10;
    dot.userData.id = id;
    dot.userData.radius = radius;
    dot.userData.range = range;
    this.content.add(dot);
    this.beacons.push(dot);
  }

  /** Apparent radius in screen pixels of something of world radius `r` at `obj`'s position. */
  private screenRadius(obj: THREE.Object3D, r: number): number {
    // A slice or cell is positioned at the centre of its disc, far from where it is: it names its own centre.
    const at = (obj.userData.pickCenter as THREE.Vector3 | undefined) ?? obj.position;
    const d = Math.max(this.camera.position.distanceTo(at), MIN_VIEW_DIST);
    return (r * this.renderer.domElement.clientHeight) / (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.invalidate();
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
        this.cancelFlight();
        // Normalise wheel units (lines / pages / pixels); one notch ≈ 100 px ≈ 15 % closer or farther.
        const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
        this.zoomPending += THREE.MathUtils.clamp(px, -400, 400) * 0.0015;
        // Zoom towards what is under the cursor: an object there (or one within a few pixels), else the
        // innermost group shell hit; only over empty space, the plane through the focus point.
        const rect = el.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        // A beacon dot under the cursor is what is aimed at, even if something stands in front of it.
        const beacon = this.nearestBeacon(ndc, rect, 14);
        // Only what is within reach of the current view: not something far behind the thing looked at.
        const reach = this.camera.position.distanceTo(this.controls.target) * ZOOM_REACH_K;
        const inReach = (q: THREE.Vector3) => q.distanceTo(this.camera.position) <= reach;
        const nodeHit = beacon ? undefined : ray.intersectObjects(this.pickNodes).find((h) => inReach(h.point));
        const nearObj = beacon || nodeHit ? null : this.nearestNode(ndc, rect, 14);
        const near = nearObj && inReach(nearObj.object.position) ? nearObj : null;
        const shellHit = ray
          .intersectObjects(this.pickShells)
          // Not the wall of a shell the camera is inside: aim at what is beyond it.
          .filter((h) => inReach(h.point) && !(h.object.userData.shell && insideShell(h.object.userData.shell as Shell, this.camera.position)))
          .sort((x, y) => x.object.userData.size - y.object.userData.size)[0];
        let p: THREE.Vector3 | null = beacon?.object.position.clone() ?? nodeHit?.point ?? near?.object.position.clone() ?? shellHit?.point ?? null;
        if (!p) {
          const normal = this.camera.getWorldDirection(new THREE.Vector3());
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.controls.target);
          p = ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? this.controls.target.clone();
        }
        this.zoomPoint = p;
        // How close the camera may come to it: a few radii of the smallest object around that point.
        this.zoomLimit = this.zoomFloor(p, this.camera.position.distanceTo(p));
      },
      { passive: false },
    );
  }

  /**
   * Closest sensible viewing distance at a point seen from `dist` away: a few radii of the smallest
   * object still around it (within the view). Deep inside, objects are tiny, so this allows deep zoom;
   * with nothing around at all, zooming further in would only sink into empty space.
   */
  private zoomFloor(at: THREE.Vector3, dist: number): number {
    let smallest = Infinity;
    for (const obj of this.pickNodes) {
      const r = obj.scale.x;
      if (r < smallest && obj.position.distanceTo(at) - r < 2 * dist) smallest = r;
    }
    // Nothing around the point under the pointer: zooming on would only sink into empty space.
    return Number.isFinite(smallest) ? Math.max(MIN_VIEW_DIST, smallest * ZOOM_FLOOR_K) : dist;
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
    // Do not pass through the focus point, nor sink into empty space: stop at a distance in keeping
    // with the nearest object there (deep inside, objects are tiny, so this still allows deep zoom).
    if (factor < 1 && newCam.distanceTo(p) < this.zoomLimit) return;
    if (newCam.distanceTo(newTarget) < MIN_VIEW_DIST) return;
    this.camera.position.copy(newCam);
    // The pivot of rotation goes onto the view line at the depth of what is zoomed at (not left
    // somewhere in front of or behind it): the view does not turn, and rotating then turns about that thing.
    const dir = newTarget.clone().sub(newCam).normalize();
    const depth = p.clone().sub(newCam).dot(dir);
    this.controls.target.copy(depth > MIN_VIEW_DIST ? newCam.clone().addScaledVector(dir, depth) : newTarget);
  }

  private lastFrame = performance.now();
  /** Path of groups around the focus point, at the top of the view; each step flies there. */
  private readonly crumbs = document.createElement('div');
  private crumbsKey = '';

  /**
   * Levels the camera is inside, from the outermost: a list under the search box, each with the
   * object's colour and a small picture of it; a click flies there. Outside everything it is empty,
   * and it grows as the camera goes in.
   */
  private updateCrumbs() {
    const layout = this.layout;
    const space = this.space;
    if (!layout || !space) return;
    // The groups around the point looked at, of those whose scale has been reached: a group counts
    // once the view is no wider than a few of its sizes (flat shells would rarely contain the camera).
    const t = this.controls.target;
    const dist = this.camera.position.distanceTo(t);
    let best: string | null = null;
    let bestDepth = -1;
    for (const [id, sh] of layout.shells) {
      const depth = layout.placed.get(id)?.depth ?? 0;
      if (depth > bestDepth && insideShell(sh, t)) {
        best = id;
        bestDepth = depth;
      }
    }
    const byId = new Map(space.nodes.map((n) => [n.id, n]));
    const chain: SpaceNode[] = [];
    for (let n = best ? byId.get(best) : undefined; n; n = n.parentId ? byId.get(n.parentId) : undefined) {
      const sh = layout.shells.get(n.id);
      const size = sh ? Math.max(sh.radii.x, sh.radii.z, sh.torus ? sh.torus.major + sh.torus.tube : 0) : 0;
      if (size * CRUMB_SCALE_K >= dist) chain.unshift(n);
    }
    const key = chain.map((n) => n.id).join('/');
    if (key === this.crumbsKey) return;
    this.crumbsKey = key;
    this.crumbs.replaceChildren();
    this.crumbs.style.display = chain.length ? '' : 'none';
    chain.forEach((n, i) => {
      const style = styleOf(space, n);
      const color = mainColor(style);
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:6px;padding:1px 0 1px ${i * 8}px;cursor:pointer;white-space:nowrap;color:${color};`;
      if (i < chain.length - 1) row.style.opacity = '0.8';
      else row.style.fontWeight = '600';
      row.append(crumbIcon(n, layout.shells.get(n.id), color, style.image));
      const text = document.createElement('span');
      text.textContent = nodeTitle(n);
      text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      row.append(text);
      row.title = nodeTitle(n);
      row.addEventListener('click', () => this.flyTo(n.id));
      this.crumbs.append(row);
    });
  }
  /** Length of the drawn axes (0 when they are off). */
  private axisLen = 0;
  /** Cardinal-direction letters at the screen edge where an axis leaves the view. */
  private readonly edgeCompass: { el: HTMLElement; dir: THREE.Vector3 }[] = [];
  private readonly edgeTmp = new THREE.Vector3();
  private activeUntil = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly tmpSphere = new THREE.Sphere();

  /** Spinning objects that are in view and big enough on screen to see them turn. */
  private visibleSpinners(): THREE.Object3D[] {
    const spinning = this.pickNodes.filter((o) => o.userData.spin);
    if (!spinning.length) return spinning;
    this.camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    const pxPerUnitAt1 = this.container.clientHeight / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return spinning.filter((o) => {
      o.getWorldPosition(this.tmpSphere.center);
      this.tmpSphere.radius = o.scale.x;
      if (!this.frustum.intersectsSphere(this.tmpSphere)) return false;
      const dist = Math.max(this.camera.position.distanceTo(this.tmpSphere.center), MIN_VIEW_DIST);
      return ((2 * o.scale.x) / dist) * pxPerUnitAt1 >= MIN_SPIN_PX;
    });
  }

  /**
   * Near and far planes follow the camera's distance to its focus: the scene can span from tiny
   * worlds to rings millions of light years across.
   */
  /** A flight has arrived when it moves less than this per frame: a tiny share of the viewing distance. */
  private flightEps() {
    return Math.max(this.camera.position.distanceTo(this.controls.target) * 1e-4, MIN_VIEW_DIST);
  }

  private fitClipping() {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(dist / 5000, MIN_VIEW_DIST / 10);
    const far = Math.max(dist * 40, this.overviewDist * 6, 5000);
    if (Math.abs(near - this.camera.near) > near * 0.01 || Math.abs(far - this.camera.far) > far * 0.01) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Whether a world point is on screen (in front of the camera, inside the view inset by `m` NDC). */
  private onScreen(v: THREE.Vector3, m: number): boolean {
    const p = this.edgeTmp.copy(v).project(this.camera);
    return p.z < 1 && Math.abs(p.x) <= 1 - m && Math.abs(p.y) <= 1 - m;
  }

  /**
   * Where an axis leaves the view (its end is out of sight), put the letter of that side of the
   * world (С, Ю, З, В) at the screen edge, so the directions stay readable when zoomed in.
   */
  private updateEdgeCompass() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const L = this.axisLen;
    const margin = 18 / Math.max(Math.min(w, h), 1);
    const o = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const { el, dir } of this.edgeCompass) {
      let shown = false;
      // The axis line starts at the origin (origin of the space); its far end is at L.
      if (L > 0 && w > 0 && h > 0 && !this.onScreen(q.copy(dir).multiplyScalar(L), 0)) {
        // Walk along the axis in steps, find the last point that is on screen, refine by bisection.
        let lo = -1;
        const steps = 80;
        for (let i = 0; i <= steps; i++) {
          const t = (i / steps) * L;
          if (this.onScreen(o.copy(dir).multiplyScalar(t), margin)) lo = t;
        }
        if (lo >= 0) {
          let a = lo;
          let b = Math.min(L, lo + L / steps);
          for (let i = 0; i < 20; i++) {
            const m = (a + b) / 2;
            if (this.onScreen(o.copy(dir).multiplyScalar(m), margin)) a = m;
            else b = m;
          }
          const p = this.edgeTmp.copy(dir).multiplyScalar(a).project(this.camera);
          el.style.left = `${((p.x + 1) / 2) * w}px`;
          el.style.top = `${((1 - p.y) / 2) * h}px`;
          shown = true;
        }
      }
      el.style.display = shown ? '' : 'none';
    }
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    const active = now < this.activeUntil || this.focusGoal !== null || this.zoomPending !== 0;
    if (!active) {
      // Idle: only small spinning objects in view keep turning, and only the 3D scene is redrawn
      // (labels do not move). Nothing to animate: no frame at all.
      const spinners = this.visibleSpinners();
      if (!spinners.length) return;
      for (const obj of spinners) obj.rotation.y += obj.userData.spin * dt;
      this.renderer.render(this.scene, this.camera);
      return;
    }
    for (const obj of this.visibleSpinners()) obj.rotation.y += obj.userData.spin * dt;
    this.stepZoom();
    if (this.focusGoal) {
      const delta = this.focusGoal.clone().sub(this.controls.target).multiplyScalar(FLY_EASE);
      this.controls.target.add(delta);
      if (this.cameraGoal) {
        const cd = this.cameraGoal.clone().sub(this.camera.position).multiplyScalar(FLY_EASE);
        this.camera.position.add(cd);
        // A waypoint stage hands over a bit early, so the flight does not crawl to a halt in the middle.
        if (this.arrival && !this.flyQueue.length && this.cameraGoal.distanceTo(this.camera.position) < this.arrival.dist * 0.6) {
          this.showCard(this.arrival.id);
          this.arrival = null;
        }
        const reached = this.flyQueue.length
          ? this.focusGoal.distanceTo(this.controls.target) < this.overviewDist * 0.08 && this.cameraGoal.distanceTo(this.camera.position) < this.overviewDist * 0.08
          : delta.length() < this.flightEps() && cd.length() < this.flightEps();
        if (reached) {
          const next = this.flyQueue.shift();
          this.focusGoal = next?.focus ?? null;
          this.cameraGoal = next?.camera ?? null;
        }
      } else {
        this.camera.position.add(delta);
        if (delta.length() < this.flightEps()) this.focusGoal = null;
      }
    }
    this.controls.update();
    this.fitClipping();
    this.updateBeacons();
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
    const ref = Math.min(dist, Math.max(nearest * 3, MIN_VIEW_DIST));
    this.placeRingLabels();
    this.layoutArcTexts();
    for (const obj of this.labelObjs) this.applyLabelDepth(obj, ref);
    this.labels.render(this.scene, this.camera);
    this.updateEdgeCompass();
    this.updateCrumbs();
    this.separateLabels();
    // The label renderer orders elements by depth; the card must stay above every caption.
    if (this.cardObj) {
      this.placeCard();
      this.cardObj.element.style.zIndex = '1000000';
    }
  }
}

/**
 * Profile of a drop (x = distance from the axis, y = height): a point at the bottom, widening, the
 * widest part above the middle, a rounded top.
 */
function dropProfile(height: number, radius: number): THREE.Vector2[] {
  const n = 64;
  const c = 0.55; // the widest part, as a share of the height
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = i / n;
    // Below the widest part: from the point outwards; above it: a rounded (elliptic) cap.
    const r = s <= c ? Math.sin((Math.PI / 2) * (s / c)) : Math.sqrt(Math.max(0, 1 - ((s - c) / (1 - c)) ** 2));
    return new THREE.Vector2(r * radius, s * height);
  });
}

/** A small picture of an object for the level list: its picture, or a sketch of its shell or shape. */
function crumbIcon(n: SpaceNode, shell: Shell | undefined, color: string, image?: string): HTMLElement {
  if (image) {
    const img = document.createElement('img');
    img.src = imageUrl(image);
    img.style.cssText = 'width:14px;height:14px;border-radius:50%;object-fit:cover;flex:none;';
    return img;
  }
  const kind = shell?.drop ? 'drop' : shell?.wedge ? 'wedge' : shell?.torus ? 'ring' : shell ? 'shell' : n.style.shape;
  const paths: Record<string, string> = {
    ring: '<circle cx="7" cy="7" r="5" fill="none" stroke="C" stroke-width="2.2"/>',
    wedge: '<path d="M7 13 L2 3 A7 7 0 0 1 12 3 Z" fill="C" fill-opacity=".45" stroke="C" stroke-width="1.2"/>',
    drop: '<path d="M7 13 C2 8 3 2 7 1.5 C11 2 12 8 7 13 Z" fill="C" fill-opacity=".45" stroke="C" stroke-width="1.2"/>',
    shell: '<ellipse cx="7" cy="7" rx="6" ry="4.5" fill="C" fill-opacity=".35" stroke="C" stroke-width="1.2"/>',
    sphere: '<circle cx="7" cy="7" r="5" fill="C"/>',
    box: '<rect x="2.5" y="2.5" width="9" height="9" fill="C"/>',
    cone: '<path d="M7 1.5 L12.5 12.5 L1.5 12.5 Z" fill="C"/>',
    octahedron: '<path d="M7 1 L12.5 7 L7 13 L1.5 7 Z" fill="C"/>',
    torus: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="C" stroke-width="2.5"/>',
    cylinder: '<rect x="3" y="1.5" width="8" height="11" rx="3" fill="C"/>',
  };
  const span = document.createElement('span');
  span.style.cssText = 'display:inline-flex;flex:none;';
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14">${(paths[kind] ?? paths.sphere).replace(/C/g, color)}</svg>`;
  return span;
}

/** Whether a point is inside a group's shell (a slice: its piece of the disc; a ring: never). */
function insideShell(sh: Shell, p: THREE.Vector3): boolean {
  if (sh.wedge) {
    const w = sh.wedge;
    const dx = p.x - w.cx;
    const dz = p.z - w.cz;
    const r = Math.hypot(dx, dz);
    if (r < w.r0 || r > w.r1 || Math.abs(p.y - sh.center.y) > sh.radii.y) return false;
    let a = Math.atan2(dz, dx);
    while (a < w.a0) a += Math.PI * 2;
    while (a > w.a0 + Math.PI * 2) a -= Math.PI * 2;
    return a <= w.a1;
  }
  if (sh.torus) {
    // Inside the ring's tube (elliptic in both directions).
    const t = sh.torus;
    const dx = p.x - sh.center.x;
    const dz = (p.z - sh.center.z) / (t.aspect ?? 1);
    const ring = Math.hypot(dx, dz) - t.major;
    return (ring / t.tube) ** 2 + ((p.y - t.y) / t.tubeY) ** 2 < 1;
  }
  const { center: c, radii: r } = sh;
  return ((p.x - c.x) / r.x) ** 2 + ((p.y - c.y) / r.y) ** 2 + ((p.z - c.z) / r.z) ** 2 < 1;
}

/** Middle of a slice relative to the centre of its disc (mid radius, mid angle). */
function wedgeCentre(w: { r0: number; r1: number; a0: number; a1: number }): THREE.Vector2 {
  const r = (w.r0 + w.r1) / 2;
  const a = (w.a0 + w.a1) / 2;
  return new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
}

/**
 * Slice of a disc (annular sector) as a flat solid: built in XY around `mid` (its own middle, so that a
 * tiny slice far from the disc's centre keeps full precision on the GPU), extruded `height` along z.
 */
function wedgeGeometry(w: { r0: number; r1: number; a0: number; a1: number }, height: number, mid: THREE.Vector2): THREE.ExtrudeGeometry {
  const steps = Math.max(8, Math.ceil(((w.a1 - w.a0) / (Math.PI * 2)) * 96));
  // r·cos a − mid: the subtraction happens here in double precision, only the small result is stored.
  const pt = (r: number, a: number) => new THREE.Vector2(r * Math.cos(a) - mid.x, r * Math.sin(a) - mid.y);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= steps; i++) pts.push(pt(w.r1, w.a0 + ((w.a1 - w.a0) * i) / steps));
  if (w.r0 > 0) for (let i = steps; i >= 0; i--) pts.push(pt(w.r0, w.a0 + ((w.a1 - w.a0) * i) / steps));
  else pts.push(new THREE.Vector2(-mid.x, -mid.y));
  const shape = new THREE.Shape(pts);
  return new THREE.ExtrudeGeometry(shape, { depth: Math.max(height, 1e-15), bevelEnabled: false, curveSegments: 1 });
}

/** Distance from a ring to the nearest other ring sharing its centre and parent (0 if none). */
function ringRoom(layout: Layout, idx: SpaceIndex, id: string): number {
  const own = layout.shells.get(id)?.torus;
  const me = layout.shells.get(id)?.center;
  const parent = idx.parentOf(id);
  if (!own || !me) return 0;
  // Free room up to the nearest edge of a neighbour sharing the centre: another ring (its tube), or a
  // shell in the middle (its outer radius). A wide neighbour does not leave room up to its middle line.
  let room = Infinity;
  for (const sib of idx.children.get(parent) ?? []) {
    if (sib.id === id) continue;
    const sh = layout.shells.get(sib.id);
    if (!sh || Math.hypot(sh.center.x - me.x, sh.center.z - me.z) > Math.max(own.major, 1e-300) * 1e-9) continue;
    if (sh.torus) room = Math.min(room, Math.max(Math.abs(sh.torus.major - own.major) - sh.torus.tube, own.tube));
    else if (!sh.wedge) room = Math.min(room, Math.max(own.major - Math.max(sh.radii.x, sh.radii.z), own.tube));
  }
  return Number.isFinite(room) ? room : 0;
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
