import './style.css';
import './i18n-en';
import { lang, nodeTitle, setLang, spaceTitle, styleName, tagName, tr } from './i18n';
import type { TagFilter } from './core/filter';
import { mountNodeCombo } from './nodeCombo';
import { computeLayout, SpaceIndex, type Layout } from './core/layout';
import { createFromTemplate, TEMPLATES, templateOf, updateFromTemplate } from './core/templates';
import { newId, type ShellCenter, type Arrange, type NamedStyle, type Shape, type Space, type SpaceNode } from './core/types';
import { loadSettings, saveSettings } from './settings';
import {
  backupSpace,
  dataFolder,
  deleteSpace,
  storageKind,
  initStorage,
  listBackups,
  listSpaces,
  loadSpace,
  onExternalChange,
  imageUrl,
  restoreBackup,
  saveSpace,
  uploadImage,
} from './storage';
import { Viewer } from './viewer/viewer';

const LEVEL_HINT = tr(`Уровень — высота узла в пространстве. Больше — выше, меньше — ниже; можно дробные и отрицательные значения (0.5, -2).

Локальный (по умолчанию): высота считается внутри родительской группы:
  Y = Y группы + смещение нуля группы + уровень × шаг уровня группы.
Уровень 0 — на пунктирном кольце группы, 1 — на один шаг выше, -1 — на шаг ниже. Двигаете группу — узел едет вместе с ней. В корне шаг = «Шаг глобального уровня» пространства.

Глобальный: Y = уровень × «Шаг глобального уровня» пространства — независимо от группы. Удобно, чтобы узлы из разных групп стояли на одном «этаже». Такой узел соединяется с группой пунктиром и не растягивает её оболочку.

Внутри вложенных групп шаг дополнительно уменьшается «Масштабом вложенных групп» (Настройки вида).`);
const LEVEL_MODE_HINT = tr(`Локальный — высота относительно родительской группы (едет вместе с ней).
Глобальный — высота от общего нуля пространства, независимо от группы.`);

const CENTER_HINT = tr(`Где центр оболочки группы:
• по содержимому — посередине между самым нижним и самым верхним содержимым;
• на уровне группы — содержимое сдвигается, чтобы центр оболочки был ровно на уровне самой группы (нулевой уровень внутри при этом может уйти вниз или вверх);
• на нулевом уровне — оболочка строится симметрично от нулевого уровня группы: совпадают позиция группы, её пунктирное кольцо и геометрический центр.`);
const FIXED_HINT = tr(`По содержимому — оболочка растёт, когда внутрь добавляют объекты.
Фиксированный — размер задаётся тремя диаметрами (восток–запад, север–юг, толщина), а всё содержимое вместе с подписями пропорционально уменьшается, чтобы поместиться. Центр — на нулевом уровне группы.`);

/** Shell centre mode of a group, including the old `centerOnLevel` flag. */
function centerOf(n: SpaceNode): ShellCenter {
  return n.frame?.center ?? (n.frame?.centerOnLevel ? 'shift' : 'content');
}

const SHAPES: Shape[] = ['sphere', 'box', 'cone', 'octahedron', 'torus', 'cylinder'];
const SHAPE_NAMES = (): Record<Shape, string> => ({
  sphere: tr('Сфера'),
  box: tr('Куб'),
  cone: tr('Конус'),
  octahedron: tr('Октаэдр'),
  torus: tr('Тор'),
  cylinder: tr('Цилиндр'),
});

let space: Space = await initStorage();
let layout: Layout | undefined;
let filter: TagFilter = { tagIds: [], mode: 'any' };
let selectedId: string | null = null;

const left = document.getElementById('left')!;
const right = document.getElementById('right')!;
const settings = loadSettings();
setupSidePanels();
setupLanguage();
const viewer = new Viewer(document.getElementById('stage')!);
viewer.setLinkOpacity(settings.linkOpacity);
viewer.setLabelDepthFade(settings.labelDepthFade);
viewer.setObjectDepthFade(settings.objectDepthFade);
viewer.labelZoom = settings.labelZoom;
viewer.labelScale = settings.labelScale;
viewer.labelShrink = settings.labelDepthShrink;
viewer.showFrames = settings.showFrames;
viewer.showAxis = settings.showAxis;
viewer.showLinks = settings.showLinks;
viewer.showGrid = settings.showGrid ?? false;
viewer.onSelect = (id) => {
  selectedId = id;
  refresh(false);
};

/** Objects found with the search field, most recent first (per space, in this browser). */
function recentSearches(): string[] {
  try {
    const raw = localStorage.getItem(`notespace.recentSearch.${space.id}`);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function rememberSearch(id: string) {
  try {
    const list = [id, ...recentSearches().filter((x) => x !== id)].slice(0, 12);
    localStorage.setItem(`notespace.recentSearch.${space.id}`, JSON.stringify(list));
  } catch {
    // storage unavailable: just no history
  }
}

// Search field over the scene: pick an object and the camera flies to it.
const searchHost = document.createElement('div');
searchHost.className = 'stage-search';
document.getElementById('stage')!.append(searchHost);
mountNodeCombo(searchHost, {
  get space() {
    return space;
  },
  get nodes() {
    return space.nodes;
  },
  placeholder: tr('Поиск по названию…'),
  // On click: Paradise and Urantia first, then what was searched for before (most recent first).
  suggest: () => [...new Set(['paradise', 'urantia', ...recentSearches()])].filter((id) => space.nodes.some((n) => n.id === id)),
  onChange: (id) => {
    if (!id) return;
    rememberSearch(id);
    selectedId = id;
    refresh(false);
    viewer.flyTo(id, true); // from search the target can be anywhere: climb out first
  },
});

refresh(true);

// A space file changed on disk (edited by hand / by an assistant, restored from a backup):
// show the new content, keeping the selection and camera.
onExternalChange(async (id, removed) => {
  if (id !== space.id) return renderLeft();
  if (removed) {
    const next = listSpaces()[0];
    const s = next ? await loadSpace(next.id) : null;
    if (s) switchTo(s);
    return;
  }
  const s = await loadSpace(id);
  if (!s) return;
  space = s;
  if (selectedId && !space.nodes.some((n) => n.id === selectedId)) selectedId = null;
  refresh(true);
  flash(tr('Пространство обновлено с диска'));
});

// Dev-only handle for inspecting state from the browser console.
if (import.meta.env.DEV) {
  Object.assign(window, { __notespace: { viewer, getSpace: () => space, getLayout: () => layout } });
}

function refresh(relayout: boolean) {
  if (relayout || !layout) layout = computeLayout(space, layout, { depthScale: settings.depthScale });
  renderScene();
  renderLeft();
  renderRight();
  saveSpace(space);
}

/** Redraws only the 3D scene (keeps the panels, e.g. a slider being dragged). */
function renderScene() {
  viewer.render(space, layout!, { filter, selectedId });
}

function switchTo(next: Space) {
  space = next;
  layout = undefined;
  selectedId = null;
  filter = { tagIds: [], mode: filter.mode };
  viewer.resetView();
  refresh(true);
}

// ---------- left panel: filter & creation ----------

function renderLeft() {
  left.innerHTML = `
    <h1>NoteSpace</h1>

    <h2>${tr('Пространство')}</h2>
    <select id="spaceSelect">
      ${listSpaces()
        .map((m) => `<option value="${esc(m.id)}" ${m.id === space.id ? 'selected' : ''}>${esc((lang === 'en' && m.en?.title) || m.title)}</option>`)
        .join('')}
    </select>
    <div class="muted">${tr('{n} узлов · {m} связей', { n: space.nodes.length, m: space.links.length })}</div>
    <div class="row">
      <select id="templateSelect">${TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button id="newSpace">${tr('Создать')}</button>
    </div>

    <h2>${tr('Теги')}</h2>
    <div class="chips">
      ${space.tags
        .map(
          (t) =>
            `<button class="chip ${filter.tagIds.includes(t.id) ? 'on' : ''}" data-tag="${esc(t.id)}" style="--c:${esc(t.color)}">#${esc(tagName(t))}</button>`,
        )
        .join('')}
    </div>
    <div class="row">
      <label><input type="radio" name="mode" value="any" ${filter.mode === 'any' ? 'checked' : ''}> ${tr('любой')}</label>
      <label><input type="radio" name="mode" value="all" ${filter.mode === 'all' ? 'checked' : ''}> ${tr('все')}</label>
      <button id="clearFilter" ${filter.tagIds.length ? '' : 'disabled'}>${tr('Сбросить')}</button>
    </div>

    <h2>${tr('Создать')}</h2>
    <div class="row">
      <button id="addNote">${tr('+ Запись')}</button>
      <button id="addGroup">${tr('+ Группа')}</button>
    </div>
    <div class="muted">${esc(targetHint())}</div>

    <h2>${tr('Настройки вида')}</h2>
    <label class="check" title="${tr('Линии между связанными записями и группами')}"><input id="showLinks" type="checkbox" ${settings.showLinks ? 'checked' : ''}> ${tr('Линии связей')}</label>
    <label>${tr('Яркость связей:')} <span id="linkOpacityValue">${Math.round(settings.linkOpacity * 100)}%</span>
      <input id="linkOpacity" type="range" min="0" max="100" step="1" value="${Math.round(settings.linkOpacity * 100)}">
    </label>
    <label title="${tr('Во сколько раз содержимое группы меньше самой группы — на каждом уровне вложенности (размер записей, шаг уровней, отступы)')}">${tr('Масштаб вложенных групп:')} <span id="depthScaleValue">${Math.round(settings.depthScale * 100)}%</span>
      <input id="depthScale" type="range" min="40" max="100" step="5" value="${Math.round(settings.depthScale * 100)}">
    </label>
    <label title="${tr('Во сколько раз уменьшается подпись на каждом уровне вложенности — дополнительно к тому, что подпись соразмерна своему объекту')}">${tr('Шрифт вложенных уровней:')} <span id="labelShrinkValue">${Math.round(settings.labelDepthShrink * 100)}%</span>
      <input id="labelShrink" type="range" min="40" max="100" step="5" value="${Math.round(settings.labelDepthShrink * 100)}">
    </label>
    <label>${tr('Размер подписей:')} <span id="labelScaleValue">${Math.round(settings.labelScale * 100)}%</span>
      <input id="labelScale" type="range" min="50" max="200" step="5" value="${Math.round(settings.labelScale * 100)}">
    </label>
    <label title="${tr('Подписи вдали от камеры тускнеют; при приближении к объекту его подписи становятся ярче')}">${tr('Затухание подписей вдали:')} <span id="labelFadeValue">${Math.round(settings.labelDepthFade * 100)}%</span>
      <input id="labelFade" type="range" min="0" max="100" step="1" value="${Math.round(settings.labelDepthFade * 100)}">
    </label>
    <label title="${tr('Удалённые от камеры объекты растворяются в фоне')}">${tr('Растворение объектов вдали:')} <span id="objectFadeValue">${Math.round(settings.objectDepthFade * 100)}%</span>
      <input id="objectFade" type="range" min="0" max="100" step="1" value="${Math.round(settings.objectDepthFade * 100)}">
    </label>
    <label class="check" title="${tr('Тонкая вертикальная линия через центр пространства')}"><input id="showAxis" type="checkbox" ${settings.showAxis ? 'checked' : ''}> ${tr('Центральная ось')}</label>
    <label class="check" title="${tr('Плоскость с сеткой под пространством')}"><input id="showGrid" type="checkbox" ${settings.showGrid ? 'checked' : ''}> ${tr('Сетка внизу')}</label>
    <label class="check" title="${tr('Пунктирное кольцо на высоте локального уровня 0 каждой группы')}"><input id="showFrames" type="checkbox" ${settings.showFrames ? 'checked' : ''}> ${tr('Нулевой уровень групп')}</label>

    <h2>${tr('Управление')}</h2>
    <ul class="help">
      <li>${tr('ЛКМ — вращение, ПКМ — сдвиг, колесо — масштаб')}</li>
      <li>${tr('Клик — выбрать (по группе — ещё и перенести к ней центр), двойной клик — перенести центр к объекту, клик в пустоту — настройки пространства')}</li>
      <li>${tr('Задержите курсор на объекте ~0,5 с — появится его описание')}</li>
      <li>${tr('Пунктирное кольцо — нулевой уровень группы (её система отсчёта)')}</li>
      <li>${tr('Пунктирная линия — запись с глобальным уровнем внутри группы')}</li>
    </ul>
  `;

  // Live update without re-rendering the panel, so the slider keeps the drag.
  on(left, '#linkOpacity', 'input', (e) => {
    settings.linkOpacity = Number((e.target as HTMLInputElement).value) / 100;
    viewer.setLinkOpacity(settings.linkOpacity);
    left.querySelector('#linkOpacityValue')!.textContent = `${Math.round(settings.linkOpacity * 100)}%`;
    saveSettings(settings);
  });
  on(left, '#labelFade', 'input', (e) => {
    settings.labelDepthFade = Number((e.target as HTMLInputElement).value) / 100;
    viewer.setLabelDepthFade(settings.labelDepthFade);
    left.querySelector('#labelFadeValue')!.textContent = `${Math.round(settings.labelDepthFade * 100)}%`;
    saveSettings(settings);
  });
  // Layout recalculation on release; the label shrink applies while dragging.
  on(left, '#depthScale', 'input', (e) => {
    left.querySelector('#depthScaleValue')!.textContent = `${(e.target as HTMLInputElement).value}%`;
  });
  on(left, '#depthScale', 'change', (e) => {
    settings.depthScale = Number((e.target as HTMLInputElement).value) / 100;
    saveSettings(settings);
    layout = computeLayout(space, layout, { depthScale: settings.depthScale });
    viewer.resetView();
    renderScene();
  });
  on(left, '#labelShrink', 'input', (e) => {
    settings.labelDepthShrink = Number((e.target as HTMLInputElement).value) / 100;
    viewer.labelShrink = settings.labelDepthShrink;
    left.querySelector('#labelShrinkValue')!.textContent = `${Math.round(settings.labelDepthShrink * 100)}%`;
    saveSettings(settings);
    renderScene();
  });
  on(left, '#labelScale', 'input', (e) => {
    settings.labelScale = Number((e.target as HTMLInputElement).value) / 100;
    viewer.labelScale = settings.labelScale;
    left.querySelector('#labelScaleValue')!.textContent = `${Math.round(settings.labelScale * 100)}%`;
    saveSettings(settings);
  });
  on(left, '#objectFade', 'input', (e) => {
    settings.objectDepthFade = Number((e.target as HTMLInputElement).value) / 100;
    viewer.setObjectDepthFade(settings.objectDepthFade);
    left.querySelector('#objectFadeValue')!.textContent = `${Math.round(settings.objectDepthFade * 100)}%`;
    saveSettings(settings);
  });
  on(left, '#showLinks', 'change', (e) => {
    settings.showLinks = (e.target as HTMLInputElement).checked;
    viewer.showLinks = settings.showLinks;
    saveSettings(settings);
    renderScene();
  });
  on(left, '#showAxis', 'change', (e) => {
    settings.showAxis = (e.target as HTMLInputElement).checked;
    viewer.showAxis = settings.showAxis;
    saveSettings(settings);
    renderScene();
  });
  on(left, '#showGrid', 'change', (e) => {
    settings.showGrid = (e.target as HTMLInputElement).checked;
    viewer.showGrid = settings.showGrid;
    saveSettings(settings);
    renderScene();
  });
  on(left, '#showFrames', 'change', (e) => {
    settings.showFrames = (e.target as HTMLInputElement).checked;
    viewer.showFrames = settings.showFrames;
    saveSettings(settings);
    refresh(false);
  });
  on(left, '#spaceSelect', 'change', (e) => {
    void loadSpace((e.target as HTMLSelectElement).value).then((next) => next && switchTo(next));
  });
  on(left, '#newSpace', 'click', () => {
    const tpl = TEMPLATES.find((t) => t.id === (left.querySelector('#templateSelect') as HTMLSelectElement).value)!;
    const title = prompt(tr('Название нового пространства'), tpl.id === 'empty' ? tr('Новое пространство') : tpl.name);
    if (title === null) return;
    const s = createFromTemplate(tpl);
    s.title = title.trim() || s.title;
    switchTo(s);
  });

  left.querySelectorAll<HTMLButtonElement>('[data-tag]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.tag!;
      filter = { ...filter, tagIds: filter.tagIds.includes(id) ? filter.tagIds.filter((t) => t !== id) : [...filter.tagIds, id] };
      refresh(false);
    }),
  );
  left.querySelectorAll<HTMLInputElement>('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => {
      filter = { ...filter, mode: r.value as TagFilter['mode'] };
      refresh(false);
    }),
  );
  on(left, '#clearFilter', 'click', () => {
    filter = { ...filter, tagIds: [] };
    refresh(false);
  });
  on(left, '#addNote', 'click', () => addNode('note'));
  on(left, '#addGroup', 'click', () => addNode('group'));
}

/** New nodes go into the selected group, or next to the selected note. */
function creationParent(): string | null {
  const sel = selectedId ? space.nodes.find((n) => n.id === selectedId) : undefined;
  if (!sel) return null;
  return sel.kind === 'group' ? sel.id : new SpaceIndex(space).parentOf(sel.id);
}

function targetHint(): string {
  const p = creationParent();
  return p ? tr('Будет создано в группе «{name}»', { name: nodeTitle(space.nodes.find((n) => n.id === p)!) }) : tr('Будет создано в корне');
}

/** Whether the "belongs to group" list offers every element, not only groups (picking a note turns it into a group). */
let showAllParents = false;

/** Turns a note into an (expanded) group in place; id, links and everything else stay. */
function makeGroup(n: SpaceNode) {
  if (n.kind === 'group') return;
  n.kind = 'group';
  n.frame = { offset: 0, levelStep: 5, collapsed: false };
}

function addNode(kind: SpaceNode['kind']) {
  const node: SpaceNode = {
    id: newId(),
    kind,
    parentId: creationParent(),
    title: kind === 'group' ? tr('Новая группа') : tr('Новая запись'),
    contentHtml: '<p>' + tr('Текст записи') + '</p>',
    tags: [],
    levelMode: 'local',
    level: 0,
    style: { color: kind === 'group' ? '#bb9af7' : '#7aa2f7', shape: kind === 'group' ? 'octahedron' : 'sphere', size: 1 },
    ...(kind === 'group' ? { frame: { offset: 0, levelStep: 5, collapsed: false } } : {}),
  };
  space.nodes.push(node);
  selectedId = node.id;
  refresh(true);
}

// ---------- right panel: inspector ----------

function renderRight() {
  const n = selectedId ? space.nodes.find((x) => x.id === selectedId) : undefined;
  if (!n) {
    renderSpaceSettings();
    return;
  }
  const idx = new SpaceIndex(space);
  const parentOptions = space.nodes.filter((g) => g.id !== n.id && (showAllParents || g.kind === 'group') && !idx.wouldCreateCycle(n.id, g.id));
  const links = space.links.filter((l) => l.from === n.id || l.to === n.id);
  const title = (id: string) => {
    const x = space.nodes.find((y) => y.id === id);
    return x ? nodeTitle(x) : '?';
  };

  right.innerHTML = `
    <h2>${n.kind === 'group' ? tr('Группа') : tr('Запись')}</h2>
    <label>${tr('Название')}${lang === 'en' ? ' (EN)' : ''}<input id="f-title" ${titleAttrs(n)}></label>
    <fieldset class="parent-pick">
      <legend>${tr('Принадлежит группе')}</legend>
      <div id="f-parent"></div>
      <label class="check"><input id="f-parent-all" type="checkbox" ${showAllParents ? 'checked' : ''}>${tr('Показать все элементы (выбранный станет группой)')}</label>
    </fieldset>

    <fieldset>
      <legend>${tr('Уровень')} <span class="hint" tabindex="0" title="${esc(LEVEL_HINT)}">?</span></legend>
      <div class="row">
        <select id="f-mode" title="${esc(LEVEL_MODE_HINT)}">
          <option value="local" ${n.levelMode === 'local' ? 'selected' : ''}>${tr('локальный')}</option>
          <option value="global" ${n.levelMode === 'global' ? 'selected' : ''}>${tr('глобальный')}</option>
        </select>
        <input id="f-level" type="number" step="0.5" value="${n.level}" title="${esc(LEVEL_HINT)}">
      </div>
      <div class="muted">${
        n.levelMode === 'local'
          ? idx.parentOf(n.id)
            ? tr('Относительно системы отсчёта родительской группы')
            : tr('В корне локальный = глобальный')
          : tr('Y = уровень × {step}, независимо от группы', { step: space.globalStep })
      }</div>
      <label class="check"><input id="f-center" type="checkbox" ${n.pinned ? 'checked' : ''}> ${idx.parentOf(n.id) ? tr('Закрепить в центре группы') : tr('Закрепить в центре сцены')}</label>
    </fieldset>

    ${
      n.kind === 'group'
        ? `<fieldset>
            <legend>${tr('Система отсчёта группы')}</legend>
            <label>${tr('Смещение нуля')}<input id="f-offset" type="number" step="0.5" value="${n.frame!.offset}"></label>
            <label>${tr('Шаг уровня')}<input id="f-step" type="number" step="0.5" min="0.5" value="${n.frame!.levelStep}"></label>
            <label>${tr('Расположение содержимого')}
              <select id="f-arrange">
                <option value="free" ${n.frame!.arrange !== 'ring' ? 'selected' : ''}>${tr('свободное')}</option>
                <option value="ring" ${n.frame!.arrange === 'ring' ? 'selected' : ''}>${tr('по кругу (закреплённые — в центре)')}</option>
                <option value="wedges" ${n.frame!.arrange === 'wedges' ? 'selected' : ''}>${tr('клинья вокруг центра (закреплённые — в центре)')}</option>
                <option value="cells" ${n.frame!.arrange === 'cells' ? 'selected' : ''}>${tr('ячейки клина (дети — по номеру ячейки)')}</option>
              </select>
            </label>
            <label>${tr('Форма оболочки')}
              <select id="f-shell">
                <option value="ellipsoid" ${n.frame!.shell !== 'torus' && n.frame!.shell !== 'sphere' && n.frame!.shell !== 'wedge' && n.frame!.shell !== 'drop' ? 'selected' : ''}>${tr('эллипсоид')}</option>
                <option value="sphere" ${n.frame!.shell === 'sphere' ? 'selected' : ''}>${tr('шар')}</option>
                <option value="torus" ${n.frame!.shell === 'torus' ? 'selected' : ''}>${tr('тор (содержимое по кольцу, закреплённые в центре)')}</option>
                <option value="drop" ${n.frame!.shell === 'drop' ? 'selected' : ''}>${tr('капля (от точки группы вверх или вниз)')}</option>
                <option value="wedge" ${n.frame!.shell === 'wedge' ? 'selected' : ''}>${tr('клин (кусок диска; в группе с расположением «клинья»)')}</option>
              </select>
            </label>
            <label title="${tr('Ширина полосы кольца в процентах от того, что оно окружает (внутреннего радиуса). 0 — по размеру содержимого.')}" ${n.frame!.shell === 'torus' ? '' : 'hidden'}>${tr('Ширина кольца, % от внутреннего радиуса')}
              <input id="f-ringWidth" type="number" min="0" step="1" value="${Math.round((n.frame!.ringWidth ?? 0) * 100)}">
            </label>
            <label title="${tr('Толщина кольца в процентах от его ширины: 100 — круглое сечение, меньше — приплюснутое. Действует, когда задана ширина.')}" ${n.frame!.shell === 'torus' && n.frame!.ringWidth ? '' : 'hidden'}>${tr('Толщина кольца, % от ширины')}
              <input id="f-ringThickness" type="number" min="1" max="100" step="1" value="${Math.round((n.frame!.ringThickness ?? 0.24) * 100)}">
            </label>
            <label title="${tr('Яркость линий оболочки относительно обычной: 100 — как у всех, меньше — тусклее')}" ${n.frame!.shell === 'wedge' || n.frame!.shell === 'torus' || !n.frame!.shell ? '' : 'hidden'}>${tr('Яркость линий оболочки, %')}
              <input id="f-edgeOpacity" type="number" min="1" max="200" step="5" value="${Math.round((n.frame!.edgeOpacity ?? 1) * 100)}">
            </label>
            <label title="${tr('Для расположения «ячейки клина»: на сколько ячеек разделён клин. Середина остаётся под столицу (дети без номера ячейки)')}" ${n.frame!.arrange === 'cells' ? '' : 'hidden'}>${tr('Число ячеек')}
              <input id="f-cells" type="number" min="1" step="1" value="${n.frame!.cells ? (n.frame!.cells.count ?? (n.frame!.cells.rings ?? 10) * (n.frame!.cells.slices ?? 10)) : 100}">
            </label>
            <label class="check" title="${tr('По умолчанию ячейки нумеруются от внешнего кольца; с галочкой — от внутреннего (у центра)')}" ${n.frame!.arrange === 'cells' ? '' : 'hidden'}><input id="f-cellsInner" type="checkbox" ${n.frame!.cells?.from === 'inner' ? 'checked' : ''}>${tr('Нумерация ячеек от центра')}</label>
            <label title="${tr('Для расположения «клинья» с фиксированным размером: какая часть радиуса в середине остаётся пустой')}" ${n.frame!.arrange === 'wedges' ? '' : 'hidden'}>${tr('Пустой центр, % радиуса')}
              <input id="f-wedgeInner" type="number" min="0" max="90" step="1" value="${Math.round((n.frame!.wedgeInner ?? 0.25) * 100)}">
            </label>
            <label title="${tr('Отношение размера север–юг к размеру восток–запад для колец и групп с расположением по кругу: 1 — круг, 7/6 — как Остров Рай. Можно ввести дробь.')}" ${n.frame!.shell === 'torus' || n.frame!.arrange === 'ring' ? '' : 'hidden'}>${tr('Вытянутость север–юг')}
              <input id="f-ringAspect" type="text" value="${n.frame!.ringAspect ? +n.frame!.ringAspect.toFixed(4) : 1}">
            </label>
            ${
              n.frame!.fixedSize
                ? tr('<div class="muted">Центр оболочки — на нулевом уровне: у фиксированного размера он всегда там. Чтобы выбрать другой, переключите «Размер оболочки» на «по содержимому».</div>')
                : ''
            }
            <label title="${esc(CENTER_HINT)}" ${n.frame!.fixedSize ? 'hidden' : ''}>${tr('Центр оболочки')}
              <select id="f-centerMode">
                <option value="content" ${centerOf(n) === 'content' ? 'selected' : ''}>${tr('по содержимому')}</option>
                <option value="shift" ${centerOf(n) === 'shift' ? 'selected' : ''}>${tr('на уровне группы (сдвиг содержимого)')}</option>
                <option value="zero" ${centerOf(n) === 'zero' ? 'selected' : ''}>${tr('на нулевом уровне (симметрично)')}</option>
              </select>
            </label>
            <label title="${esc(FIXED_HINT)}">${tr('Размер оболочки')}
              <select id="f-sizing">
                <option value="content" ${n.frame!.fixedSize ? '' : 'selected'}>${tr('по содержимому')}</option>
                <option value="fixed" ${n.frame!.fixedSize ? 'selected' : ''}>${tr('фиксированный (содержимое масштабируется)')}</option>
              </select>
            </label>
            ${
              n.frame!.fixedSize
                ? `<div class="row" title="${tr('Диаметры оболочки')}">
                    <label>${tr('В–З (X)')}<input id="f-fx" type="number" step="0.5" min="0.1" value="${n.frame!.fixedSize.x}"></label>
                    <label>${tr('С–Ю (Z)')}<input id="f-fz" type="number" step="0.5" min="0.1" value="${n.frame!.fixedSize.z}"></label>
                    <label>${tr('Толщина (Y)')}<input id="f-fy" type="number" step="0.1" min="0.05" value="${n.frame!.fixedSize.y}"></label>
                  </div>
                  <label title="${tr('Какую долю ширины оболочки занимает содержимое. 100% — заполняет целиком (может и увеличить содержимое), меньше — всё внутри, вместе с подписями, пропорционально уменьшается')}">${tr('Заполнение содержимым:')} <span id="f-fillValue">${Math.round((n.frame!.fill ?? 1) * 100)}%</span>
                    <input id="f-fill" type="range" min="5" max="100" step="5" value="${Math.round((n.frame!.fill ?? 1) * 100)}">
                  </label>`
                : ''
            }
            <label>${tr('Видимость оболочки:')} ${Math.round((n.frame!.shellOpacity ?? 1) * 100)}%
              <input id="f-shellOpacity" type="range" min="0" max="100" step="5" value="${Math.round((n.frame!.shellOpacity ?? 1) * 100)}">
            </label>
            <label class="check"><input id="f-collapsed" type="checkbox" ${n.frame!.collapsed ? 'checked' : ''}> ${tr('Свернуть')}</label>
          </fieldset>`
        : ''
    }

    <fieldset>
      <legend>${tr('Вид')}</legend>
      <label>${tr('Стиль')}
        <select id="f-style">
          <option value="">${tr('— свой —')}</option>
          ${(space.styles ?? []).map((s) => `<option value="${esc(s.id)}" ${n.styleId === s.id ? 'selected' : ''}>${esc(styleName(s))}</option>`).join('')}
        </select>
      </label>
      ${
        n.styleId
          ? tr('<div class="muted">Цвет, форма и размер берутся из стиля. Изменить стиль — в настройках пространства (снимите выделение).</div>')
          : `<div class="row">
              <select id="f-shape">${SHAPES.map((s) => `<option value="${s}" ${n.style.shape === s ? 'selected' : ''}>${SHAPE_NAMES()[s]}</option>`).join('')}</select>
              <input id="f-color" type="color" value="${esc(n.style.color)}">
              <input id="f-size" type="number" step="0.1" min="0.3" value="${n.style.size}" title="${tr('Размер')}">
            </div>
            <div class="row" title="${tr('Фигура делится на равные цветные доли (например, природа Отца и Сына)')}">
              <span class="muted">${tr('Доли цвета:')}</span>
              ${(n.style.colors ?? [])
                .map((c, i) => `<input type="color" data-ci="${i}" value="${esc(c)}"><button data-cdel="${i}" title="${tr('Убрать долю')}">×</button>`)
                .join('')}
              <button id="f-cadd" title="${tr('Добавить цветную долю')}">${tr('+ доля')}</button>
            </div>
            ${imageRowHtml(n.style.image, 'id="f-img"', 'id="f-imgdel"')}
            <button id="f-saveStyle">${tr('Сохранить как новый стиль…')}</button>`
      }
      <div class="field" title="${tr('Для узлов внутри группы с расположением по кругу или формой «тор»: узел встаёт на кольце на линии от центра группы к выбранному узлу')}">${tr('Направить на')}
        <div id="f-aimAt"></div>
      </div>
      <label class="check" title="${tr('Название не рисуется рядом с объектом; карточка с описанием при наведении остаётся')}"><input id="f-nolabel" type="checkbox" ${n.hideLabel ? 'checked' : ''}>${tr('Не показывать название')}</label>
      <label class="check" title="${tr('Всегда заметна: точка постоянного размера видна с любого расстояния, на неё можно навести мышь издалека, название не тускнеет')}"><input id="f-beacon" type="checkbox" ${n.beacon ? 'checked' : ''}>${tr('Всегда заметна')}</label>
      <label class="check" title="${tr('Не подсвечивается и не показывает карточку при наведении: мышь «проходит» к тому, что вокруг')}"><input id="f-passive" type="checkbox" ${n.passive ? 'checked' : ''}>${tr('Не реагирует на мышь')}</label>
      <label title="${tr('Если родитель — группа с расположением «ячейки клина»: номер ячейки, которую занимает этот объект. Нумерация с 1: сначала средний слой, затем слои выше и ниже по очереди; в слое — по кольцам от внешнего края (или от центра, если так задано у родителя), в кольце — по углу. Центральная ячейка среднего слоя отдана столице и не нумеруется.')}">${tr('Номер ячейки')}
        <input id="f-cell" type="number" min="0" step="1" value="${n.cell ?? ''}">
      </label>
      <label title="${tr('Во сколько раз название этого объекта крупнее обычного (1 — как у всех)')}">${tr('Размер названия, ×')}
        <input id="f-labelScale" type="number" min="0.2" max="20" step="0.1" value="${n.labelScale ?? 1}">
      </label>
      <label title="${tr('Вращение вокруг вертикальной оси, оборотов в минуту. 0 — не вращается')}">${tr('Вращение (об/мин)')}
        <input id="f-spin" type="number" step="1" value="${n.spin ?? 0}">
      </label>
      <div class="field">${tr('Размер как')}
        <div id="f-sizeAs"></div>
      </div>
    </fieldset>

    <fieldset>
      <legend>${tr('Теги')}</legend>
      <div class="chips">
        ${space.tags
          .map(
            (t) =>
              `<label class="chip ${n.tags.includes(t.id) ? 'on' : ''}" style="--c:${esc(t.color)}"><input type="checkbox" data-ntag="${esc(t.id)}" ${n.tags.includes(t.id) ? 'checked' : ''}>#${esc(tagName(t))}</label>`,
          )
          .join('')}
      </div>
    </fieldset>

    <label>${tr('Содержимое (HTML)')}${lang === 'en' ? ' (EN)' : ''}<textarea id="f-html" rows="6" ${htmlAttrs(n)}>${esc(lang === 'en' ? (n.en?.contentHtml ?? '') : n.contentHtml)}</textarea></label>

    <fieldset>
      <legend>${tr('Связи')}</legend>
      <ul class="links">
        ${links
          .map(
            (l) =>
              `<li>${l.from === n.id ? '→' : '←'} ${esc(title(l.from === n.id ? l.to : l.from))}${l.label ? ` <i>(${esc(l.label)})</i>` : ''} <button data-unlink="${esc(l.id)}" title="${tr('Удалить связь')}">×</button></li>`,
          )
          .join('') || `<li class="muted">${tr('нет')}</li>`}
      </ul>
      <div class="row">
        <div id="l-target"></div>
      </div>
      <div class="row">
        <input id="l-label" placeholder="${tr('подпись')}">
        <label class="check"><input id="l-directed" type="checkbox" checked>→</label>
        <button id="l-add">${tr('Связать')}</button>
      </div>
    </fieldset>

    ${n.kind === 'group' ? '' : `<button id="make-group">${tr('Сделать группой')}</button>`}
    <button id="delete" class="danger">${n.kind === 'group' ? tr('Удалить группу (содержимое поднимется выше)') : tr('Удалить запись')}</button>
  `;

  const edit = (sel: string, apply: (el: HTMLInputElement) => void, relayout = true) =>
    on(right, sel, 'change', (e) => {
      apply(e.target as HTMLInputElement);
      refresh(relayout);
    });

  edit('#f-title', (el) => {
    if (lang === 'en') setEn(n, 'title', el.value.trim());
    else n.title = el.value.trim() || n.title;
  });
  on(right, '#f-parent-all', 'change', (e) => {
    showAllParents = (e.target as HTMLInputElement).checked;
    renderRight();
  });
  on(right, '#make-group', 'click', () => {
    makeGroup(n);
    refresh(true);
  });
  mountNodeCombo(right.querySelector('#f-parent') as HTMLElement, {
    space,
    nodes: parentOptions,
    value: idx.parentOf(n.id),
    emptyLabel: tr('— корень —'),
    onChange: (id) => {
      n.parentId = id;
      n.pinned = undefined;
      const parent = id ? space.nodes.find((x) => x.id === id) : undefined;
      if (parent) makeGroup(parent);
      refresh(true);
    },
  });
  const others = space.nodes.filter((x) => x.id !== n.id);
  mountNodeCombo(right.querySelector('#f-aimAt') as HTMLElement, {
    space,
    nodes: others,
    value: n.aimAt,
    emptyLabel: tr('— по порядку —'),
    onChange: (id) => {
      n.aimAt = id ?? undefined;
      refresh(true);
    },
  });
  mountNodeCombo(right.querySelector('#f-sizeAs') as HTMLElement, {
    space,
    nodes: others,
    value: n.sizeAs,
    emptyLabel: tr('— собственный —'),
    onChange: (id) => {
      n.sizeAs = id ?? undefined;
      refresh(true);
    },
  });
  let linkTarget: string | null = null;
  mountNodeCombo(right.querySelector('#l-target') as HTMLElement, {
    space,
    nodes: others,
    value: null,
    onChange: (id) => (linkTarget = id),
  });
  edit('#f-mode', (el) => (n.levelMode = el.value as SpaceNode['levelMode']));
  edit('#f-level', (el) => (n.level = num(el, n.level)));
  edit('#f-offset', (el) => (n.frame!.offset = num(el, n.frame!.offset)));
  edit('#f-step', (el) => (n.frame!.levelStep = Math.max(0.5, num(el, n.frame!.levelStep))));
  edit('#f-collapsed', (el) => (n.frame!.collapsed = el.checked));
  edit('#f-arrange', (el) => (n.frame!.arrange = el.value as Arrange));
  edit('#f-shell', (el) => (n.frame!.shell = el.value === 'torus' || el.value === 'sphere' || el.value === 'wedge' || el.value === 'drop' ? el.value : undefined));
  edit('#f-ringWidth', (el) => {
    const v = Math.max(0, num(el, 0)) / 100;
    n.frame!.ringWidth = v > 0 ? v : undefined;
  });
  edit('#f-edgeOpacity', (el) => {
    const v = Math.max(0.01, num(el, 100) / 100);
    n.frame!.edgeOpacity = Math.abs(v - 1) > 1e-6 ? v : undefined;
  }, false);
  edit('#f-cells', (el) => {
    const count = Math.round(num(el, 100));
    n.frame!.cells = count >= 1 ? { count, ...(n.frame!.cells?.from ? { from: n.frame!.cells.from } : {}) } : undefined;
  });
  edit('#f-cellsInner', (el) => {
    const c = n.frame!.cells;
    n.frame!.cells = { count: c?.count ?? (c?.rings ?? 10) * (c?.slices ?? 10), ...(el.checked ? { from: 'inner' as const } : {}) };
  });
  edit('#f-wedgeInner', (el) => {
    const v = Math.min(0.9, Math.max(0, num(el, 25) / 100));
    n.frame!.wedgeInner = Math.abs(v - 0.25) > 1e-6 ? v : undefined;
  });
  edit('#f-cell', (el) => {
    const v = Math.round(num(el, 0));
    n.cell = v >= 1 ? v : undefined;
  });
  edit('#f-ringAspect', (el) => {
    const [a, b] = el.value.replace(',', '.').split('/').map(Number);
    const v = b ? a / b : a;
    n.frame!.ringAspect = Number.isFinite(v) && v > 0 && Math.abs(v - 1) > 1e-6 ? v : undefined;
  });
  edit('#f-ringThickness', (el) => {
    const v = Math.min(100, Math.max(1, num(el, 24))) / 100;
    n.frame!.ringThickness = v === 0.24 ? undefined : v;
  });
  edit('#f-centerMode', (el) => {
    n.frame!.center = el.value === 'content' ? undefined : (el.value as ShellCenter);
    n.frame!.centerOnLevel = undefined; // replaced by `center`
  });
  edit('#f-sizing', (el) => {
    if (el.value === 'fixed') {
      // Start from the current size, so switching does not jump.
      const r = layout?.shells.get(n.id)?.radii;
      const d = (v: number | undefined) => Math.round((v ?? 10) * 2 * 10) / 10;
      n.frame!.fixedSize = { x: d(r?.x), y: d(r?.y), z: d(r?.z) };
    } else n.frame!.fixedSize = undefined;
  });
  edit('#f-fx', (el) => (n.frame!.fixedSize!.x = Math.max(0.1, num(el, n.frame!.fixedSize!.x))));
  edit('#f-fz', (el) => (n.frame!.fixedSize!.z = Math.max(0.1, num(el, n.frame!.fixedSize!.z))));
  // Live value while dragging; the layout is recalculated on release.
  // Live while dragging: relayout and redraw the scene once per frame (the panel stays as is, so
  // the slider keeps the drag); saving and the panel refresh happen on release.
  let fillFrame = 0;
  on(right, '#f-fill', 'input', (e) => {
    const value = Number((e.target as HTMLInputElement).value);
    right.querySelector('#f-fillValue')!.textContent = `${value}%`;
    n.frame!.fill = value / 100;
    if (fillFrame) return;
    fillFrame = requestAnimationFrame(() => {
      fillFrame = 0;
      layout = computeLayout(space, layout, { depthScale: settings.depthScale });
      renderScene();
    });
  });
  edit('#f-fill', (el) => (n.frame!.fill = Number(el.value) / 100));
  edit('#f-fy', (el) => (n.frame!.fixedSize!.y = Math.max(0.05, num(el, n.frame!.fixedSize!.y))));
  edit('#f-center', (el) => (n.pinned = el.checked ? { x: 0, z: 0 } : undefined));
  edit('#f-style', (el) => (n.styleId = el.value || undefined));
  edit('#f-nolabel', (el) => (n.hideLabel = el.checked || undefined), false);
  edit('#f-beacon', (el) => (n.beacon = el.checked || undefined), false);
  edit('#f-passive', (el) => (n.passive = el.checked || undefined), false);
  edit('#f-labelScale', (el) => {
    const v = num(el, 1);
    n.labelScale = v > 0 && Math.abs(v - 1) > 1e-6 ? v : undefined;
  }, false);
  edit('#f-spin', (el) => (n.spin = num(el, 0) || undefined), false);
  edit('#f-shellOpacity', (el) => (n.frame!.shellOpacity = Number(el.value) / 100), false);
  right.querySelectorAll<HTMLInputElement>('[data-ci]').forEach((el) =>
    el.addEventListener('change', () => {
      n.style.colors![Number(el.dataset.ci)] = el.value;
      refresh(false);
    }),
  );
  right.querySelectorAll<HTMLButtonElement>('[data-cdel]').forEach((b) =>
    b.addEventListener('click', () => {
      n.style.colors = n.style.colors!.filter((_, i) => i !== Number(b.dataset.cdel));
      if (!n.style.colors.length) n.style.colors = undefined;
      refresh(false);
    }),
  );
  on(right, '#f-cadd', 'click', () => {
    // The first sector starts from the node's own colour.
    n.style.colors = [...(n.style.colors ?? [n.style.color]), '#ffffff'];
    refresh(false);
  });
  on(right, '#f-saveStyle', 'click', () => {
    const name = prompt(tr('Название стиля (например, «Ангелы»)'))?.trim();
    if (!name) return;
    const style: NamedStyle = { id: newId(), name, ...n.style };
    space.styles = [...(space.styles ?? []), style];
    n.styleId = style.id;
    refresh(true);
  });
  on(right, '#f-img', 'click', () =>
    void pickImage().then((name) => {
      if (!name) return;
      n.style.image = name;
      refresh(false);
    }),
  );
  on(right, '#f-imgdel', 'click', () => {
    n.style.image = undefined;
    refresh(false);
  });
  edit('#f-shape', (el) => (n.style.shape = el.value as Shape), false);
  edit('#f-color', (el) => (n.style.color = el.value), false);
  edit('#f-size', (el) => (n.style.size = Math.max(0.3, num(el, n.style.size))));
  edit('#f-html', (el) => (lang === 'en' ? setEn(n, 'contentHtml', el.value) : (n.contentHtml = el.value)), false);
  right.querySelectorAll<HTMLInputElement>('[data-ntag]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const t = cb.dataset.ntag!;
      n.tags = cb.checked ? [...n.tags, t] : n.tags.filter((x) => x !== t);
      refresh(false);
    }),
  );
  right.querySelectorAll<HTMLButtonElement>('[data-unlink]').forEach((b) =>
    b.addEventListener('click', () => {
      space.links = space.links.filter((l) => l.id !== b.dataset.unlink);
      refresh(true);
    }),
  );
  on(right, '#l-add', 'click', () => {
    const to = linkTarget;
    const label = (right.querySelector('#l-label') as HTMLInputElement).value.trim();
    const directed = (right.querySelector('#l-directed') as HTMLInputElement).checked;
    if (!to) return;
    space.links.push({ id: newId(), from: n.id, to, directed, ...(label ? { label } : {}) });
    refresh(true);
  });
  on(right, '#delete', 'click', () => {
    if (!confirm(tr('Удалить «{name}»?', { name: nodeTitle(n) }))) return;
    const parent = idx.parentOf(n.id);
    for (const c of space.nodes) if (c.parentId === n.id) c.parentId = parent;
    space.nodes = space.nodes.filter((x) => x.id !== n.id);
    space.links = space.links.filter((l) => l.from !== n.id && l.to !== n.id);
    selectedId = null;
    refresh(true);
  });
}

// ---------- right panel: space settings (nothing selected) ----------

function renderSpaceSettings() {
  const usage = (tagId: string) => space.nodes.filter((n) => n.tags.includes(tagId)).length;
  right.innerHTML = `
    <h2>${tr('Пространство')}</h2>
    <label>${tr('Название')}${lang === 'en' ? ' (EN)' : ''}<input id="s-title" ${lang === 'en' ? `value="${esc(space.en?.title ?? '')}" placeholder="${esc(space.title)}"` : `value="${esc(space.title)}"`}></label>
    <label>${tr('Шаг глобального уровня')}<input id="s-step" type="number" step="1" min="1" value="${space.globalStep}"></label>

    <div class="field">${tr('Ближе к зрителю при открытии')}
      <div id="s-front"></div>
    </div>
    <div class="field">${tr('Начало координат')}
      <div id="s-origin"></div>
    </div>

    <fieldset>
      <legend>${tr('Шаблон')}</legend>
      <div class="row">
        <select id="s-template">
          ${TEMPLATES.filter((t) => t.id !== 'empty')
            .map((t) => `<option value="${t.id}" ${templateOf(space)?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)
            .join('')}
        </select>
        <button id="s-update">${tr('Обновить из шаблона')}</button>
      </div>
      <div class="muted">${tr('Записи, связи, теги и стили шаблона заменятся текущей версией. Ваши собственные записи и связи сохранятся, но правки в записях шаблона будут потеряны.')}</div>
    </fieldset>

    <fieldset>
      <legend>${tr('Резервные копии')}</legend>
      <div class="row">
        <button id="b-make">${tr('Сделать копию')}</button>
        <button id="b-export" title="${tr('Скачать пространство файлом .json')}">${tr('Экспорт')}</button>
        <button id="b-import" title="${tr('Загрузить пространство из файла .json')}">${tr('Импорт…')}</button>
      </div>
      <ul class="links" id="b-list"><li class="muted">${tr('загрузка…')}</li></ul>
      <div class="muted">${esc(backupsHint())}</div>
    </fieldset>

    <fieldset>
      <legend>${tr('Теги')}</legend>
      <ul class="links">
        ${space.tags
          .map(
            (t) =>
              `<li><input type="color" data-tagcolor="${esc(t.id)}" value="${esc(t.color)}"><span style="color:${esc(t.color)}">#${esc(tagName(t))}</span><span class="muted">${usage(t.id)}</span><button data-deltag="${esc(t.id)}" title="${tr('Удалить тег')}">×</button></li>`,
          )
          .join('') || `<li class="muted">${tr('нет')}</li>`}
      </ul>
      <div class="row">
        <input id="t-name" placeholder="${tr('новый тег')}">
        <input id="t-color" type="color" value="#7aa2f7">
        <button id="t-add">${tr('Добавить')}</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>${tr('Стили')}</legend>
      ${(space.styles ?? [])
        .map(
          (s) => `<div class="style-row">
            <div class="row">
              <input data-sname="${esc(s.id)}" ${lang === 'en' ? `value="${esc(s.en ?? '')}" placeholder="${esc(s.name)}"` : `value="${esc(s.name)}"`}>
              <span class="muted" title="${tr('Узлов с этим стилем')}">${space.nodes.filter((n) => n.styleId === s.id).length}</span>
              <button data-sdel="${esc(s.id)}" title="${tr('Удалить стиль')}">×</button>
            </div>
            <div class="row">
              <select data-sshape="${esc(s.id)}">${SHAPES.map((sh) => `<option value="${sh}" ${s.shape === sh ? 'selected' : ''}>${SHAPE_NAMES()[sh]}</option>`).join('')}</select>
              <input type="color" data-scolor="${esc(s.id)}" value="${esc(s.color)}">
              <input type="number" step="0.1" min="0.3" data-ssize="${esc(s.id)}" value="${s.size}" title="${tr('Размер')}">
            </div>
            ${imageRowHtml(s.image, `data-simg="${esc(s.id)}"`, `data-simgdel="${esc(s.id)}"`)}
          </div>`,
        )
        .join('') || `<div class="muted">${tr('нет — создайте здесь или кнопкой «Сохранить как новый стиль» у записи')}</div>`}
      <div class="row">
        <input id="st-name" placeholder="${tr('новый стиль')}">
        <button id="st-add">${tr('Добавить')}</button>
      </div>
    </fieldset>

    <div class="muted">${tr('Выберите запись или группу в сцене, чтобы редактировать её.')}</div>
    <button id="s-delete" class="danger" ${listSpaces().length > 1 ? '' : 'disabled'}>${tr('Удалить пространство')}</button>
  `;

  bindBackups();
  on(right, '#s-update', 'click', () => {
    const tpl = TEMPLATES.find((t) => t.id === (right.querySelector('#s-template') as HTMLSelectElement).value)!;
    if (!confirm(tr(`Обновить «{space}» из шаблона «{tpl}»?
Правки в записях шаблона будут потеряны, ваши собственные записи сохранятся.`, { space: spaceTitle(space), tpl: tpl.name }))) return;
    void backupSpace(space, 'before-template-update').then(() => {
      const { space: updated, keptNodes } = updateFromTemplate(space, tpl);
      switchTo(updated);
      flash(keptNodes ? tr('Обновлено из шаблона. Резервная копия сохранена, ваших записей сохранено: {n}.', { n: keptNodes }) : tr('Обновлено из шаблона. Резервная копия сохранена.'));
    });
  });
  mountNodeCombo(right.querySelector('#s-origin') as HTMLElement, {
    space,
    nodes: space.nodes,
    value: space.originNodeId,
    emptyLabel: tr('— по уровням —'),
    onChange: (id) => {
      space.originNodeId = id ?? undefined;
      viewer.resetView();
      refresh(false);
    },
  });
  mountNodeCombo(right.querySelector('#s-front') as HTMLElement, {
    space,
    nodes: space.nodes,
    value: space.frontNodeId,
    emptyLabel: tr('— авто —'),
    onChange: (id) => {
      space.frontNodeId = id ?? undefined;
      viewer.resetView();
      refresh(false);
    },
  });
  on(right, '#s-title', 'change', (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (lang === 'en') space.en = v ? { ...space.en, title: v } : undefined;
    else space.title = v || space.title;
    refresh(false);
  });
  on(right, '#s-step', 'change', (e) => {
    space.globalStep = Math.max(1, num(e.target as HTMLInputElement, space.globalStep));
    refresh(true);
  });
  right.querySelectorAll<HTMLInputElement>('[data-tagcolor]').forEach((el) =>
    el.addEventListener('change', () => {
      space.tags.find((t) => t.id === el.dataset.tagcolor)!.color = el.value;
      refresh(false);
    }),
  );
  right.querySelectorAll<HTMLButtonElement>('[data-deltag]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.deltag!;
      const t = space.tags.find((x) => x.id === id)!;
      if (usage(id) && !confirm(tr('Тег #{tag} используется в {n} узлах. Удалить?', { tag: tagName(t), n: usage(id) }))) return;
      space.tags = space.tags.filter((x) => x.id !== id);
      for (const n of space.nodes) n.tags = n.tags.filter((x) => x !== id);
      filter = { ...filter, tagIds: filter.tagIds.filter((x) => x !== id) };
      refresh(false);
    }),
  );
  on(right, '#t-add', 'click', () => {
    const name = (right.querySelector('#t-name') as HTMLInputElement).value.trim().replace(/^#/, '');
    if (!name || space.tags.some((t) => t.name === name)) return;
    space.tags.push({ id: newId(), name, color: (right.querySelector('#t-color') as HTMLInputElement).value });
    refresh(false);
  });
  const styleById = (id: string) => space.styles!.find((s) => s.id === id)!;
  const bindStyle = (attr: string, apply: (s: NamedStyle, el: HTMLInputElement) => void, relayout: boolean) =>
    right.querySelectorAll<HTMLInputElement>(`[data-${attr}]`).forEach((el) =>
      el.addEventListener('change', () => {
        apply(styleById(el.dataset[attr]!), el);
        refresh(relayout);
      }),
    );
  bindStyle('sname', (s, el) => (lang === 'en' ? (s.en = el.value.trim() || undefined) : (s.name = el.value.trim() || s.name)), false);
  bindStyle('sshape', (s, el) => (s.shape = el.value as Shape), false);
  bindStyle('scolor', (s, el) => (s.color = el.value), false);
  bindStyle('ssize', (s, el) => (s.size = Math.max(0.3, num(el, s.size))), true);
  right.querySelectorAll<HTMLButtonElement>('[data-simg]').forEach((b) =>
    b.addEventListener('click', () =>
      void pickImage().then((name) => {
        if (!name) return;
        styleById(b.dataset.simg!).image = name;
        refresh(false);
      }),
    ),
  );
  right.querySelectorAll<HTMLButtonElement>('[data-simgdel]').forEach((b) =>
    b.addEventListener('click', () => {
      styleById(b.dataset.simgdel!).image = undefined;
      refresh(false);
    }),
  );
  right.querySelectorAll<HTMLButtonElement>('[data-sdel]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = styleById(b.dataset.sdel!);
      const users = space.nodes.filter((n) => n.styleId === s.id);
      if (users.length && !confirm(tr('Стиль «{style}» используют {n} узлов. Удалить? Они сохранят его вид как собственный.', { style: styleName(s), n: users.length }))) return;
      for (const n of users) {
        n.style = { color: s.color, shape: s.shape, size: s.size, ...(s.colors ? { colors: s.colors } : {}), ...(s.image ? { image: s.image } : {}) };
        n.styleId = undefined;
      }
      space.styles = space.styles!.filter((x) => x.id !== s.id);
      refresh(true);
    }),
  );
  on(right, '#st-add', 'click', () => {
    const name = (right.querySelector('#st-name') as HTMLInputElement).value.trim();
    if (!name) return;
    space.styles = [...(space.styles ?? []), { id: newId(), name, color: '#7aa2f7', shape: 'sphere', size: 1 }];
    refresh(false);
  });
  on(right, '#s-delete', 'click', () => {
    if (!confirm(tr('Удалить пространство «{name}» со всеми записями?', { name: spaceTitle(space) }))) return;
    void deleteSpace(space.id)
      .then((nextId) => (nextId ? loadSpace(nextId) : null))
      .then((next) => next && switchTo(next));
  });
}

// ---------- side panels: hide / show and resize ----------

const PANEL_MIN = 180;
const PANEL_MAX = 640;

function setupSidePanels() {
  for (const side of ['left', 'right'] as const) {
    const el = document.getElementById(`${side}-side`)!;
    const state = settings.panels[side];
    // Nothing on the panels is meant to be dragged: without this, pulling a slider after some text
    // got selected starts dragging that text (the "no entry" cursor) instead of moving the slider.
    el.addEventListener('dragstart', (e) => e.preventDefault());
    const apply = () => {
      el.classList.toggle('collapsed', state.collapsed);
      el.style.setProperty('--w', `${state.width}px`);
    };
    apply();

    el.querySelector(`[data-toggle="${side}"]`)!.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      apply();
      saveSettings(settings);
    });

    // Drag the inner edge; the left panel grows to the right, the right one to the left.
    const handle = el.querySelector('.resizer') as HTMLElement;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = state.width;
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) * (side === 'left' ? 1 : -1);
        state.width = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, startW + dx)));
        apply();
      };
      const up = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        saveSettings(settings);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
}

/** Interface language: rail tooltips and the switch button under the left toggle. */
function setupLanguage() {
  document.documentElement.lang = lang;
  for (const [sel, text] of [
    ['[data-toggle="left"]', tr('Скрыть / показать левую панель')],
    ['[data-toggle="right"]', tr('Скрыть / показать правую панель')],
  ] as const)
    document.querySelector(sel)?.setAttribute('title', text);
  document.querySelectorAll('.resizer').forEach((el) => el.setAttribute('title', tr('Потяните, чтобы изменить ширину')));
  const rail = document.querySelector('#left-side .rail');
  if (!rail) return;
  const btn = document.createElement('button');
  btn.className = 'rail-btn lang-btn';
  btn.textContent = lang === 'en' ? 'RU' : 'EN';
  btn.title = lang === 'en' ? 'Переключить интерфейс на русский' : 'Switch the interface to English';
  btn.addEventListener('click', () => setLang(lang === 'en' ? 'ru' : 'en'));
  rail.append(btn);
}

// ---------- backups, export, import ----------

function bindBackups() {
  const forId = space.id;
  const list = right.querySelector('#b-list') as HTMLElement;
  const fmt = (t: number) => new Date(t).toLocaleString(lang === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  const reasons: Record<string, string> = {
    manual: tr('вручную'),
    'before-template-update': tr('перед обновлением из шаблона'),
    'before-delete': tr('перед удалением'),
    'before-restore': tr('перед восстановлением'),
    'before-import': tr('перед импортом'),
  };
  const fill = () =>
    void listBackups(forId).then((items) => {
      if (space.id !== forId || !right.contains(list)) return; // panel was re-rendered meanwhile
      list.innerHTML =
        items
          .slice(0, 10)
          .map(
            (b) =>
              `<li><span>${esc(fmt(b.time))}</span><span class="muted">${esc(reasons[b.reason] ?? b.reason)}</span><button data-restore="${esc(b.name)}">${tr('Восстановить')}</button></li>`,
          )
          .join('') || `<li class="muted">${tr('пока нет')}</li>`;
      list.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((btn) =>
        btn.addEventListener('click', () => {
          if (!confirm(tr('Восстановить эту копию? Текущее состояние тоже сохранится в копию.'))) return;
          void restoreBackup(forId, btn.dataset.restore!).then((s) => {
            switchTo(s);
            flash(tr('Копия восстановлена'));
          });
        }),
      );
    });
  fill();

  on(right, '#b-make', 'click', () => void backupSpace(space, 'manual').then(() => (fill(), flash(tr('Копия сохранена')))));
  on(right, '#b-export', 'click', () => {
    const blob = new Blob([JSON.stringify(space, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${space.title.replace(/[\\/:*?"<>|]+/g, '_')}.notespace.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  on(right, '#b-import', 'click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const s = JSON.parse(await file.text()) as Space;
        if (!Array.isArray(s.nodes) || !Array.isArray(s.links)) throw new Error('not a NoteSpace file');
        // An import never overwrites an existing space: it gets its own id if that one is taken.
        if (listSpaces().some((m) => m.id === s.id)) s.id = newId();
        switchTo(s);
        flash(tr('Импортировано: «{name}»', { name: spaceTitle(s) }));
      } catch (e) {
        alert(tr('Не удалось импортировать файл: {error}', { error: String(e) }));
      }
    });
    input.click();
  });
}

/** Short non-blocking message at the bottom of the scene. */
/** Lets the user pick a picture file, uploads it and returns its stored name (null: cancelled or failed). */
function pickImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      uploadImage(file).then(resolve, (e: unknown) => {
        flash(e instanceof Error ? e.message : String(e));
        resolve(null);
      });
    });
    input.click();
  });
}

/** Markup of a "Картинка" row; `upload` / `remove` are the attributes (id or data-*) that bind its two buttons. */
function imageRowHtml(image: string | undefined, upload: string, remove: string): string {
  return `<div class="row">
    <span class="muted">${tr('Картинка:')}</span>
    ${image ? `<img class="style-thumb" src="${esc(imageUrl(image))}" alt="">` : `<span class="muted">${tr('нет')}</span>`}
    <button ${upload} title="${tr('Показывать элемент этой картинкой вместо фигуры (png, jpg, gif, webp, svg)')}">${tr('Загрузить…')}</button>
    ${image ? `<button ${remove} title="${tr('Убрать картинку')}">×</button>` : ''}
  </div>`;
}

function flash(text: string) {
  const el = document.createElement('div');
  el.className = 'flash';
  el.textContent = text;
  document.getElementById('stage')!.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- helpers ----------

/** Attributes of the title field: in English mode it edits `n.en.title`, the Russian shows as a placeholder. */
function titleAttrs(n: SpaceNode): string {
  return lang === 'en' ? `value="${esc(n.en?.title ?? '')}" placeholder="${esc(n.title)}"` : `value="${esc(n.title)}"`;
}

function htmlAttrs(n: SpaceNode): string {
  return lang === 'en' ? `placeholder="${esc(n.contentHtml)}"` : '';
}

/** Sets (or, when empty, clears) an English field of a node; drops `en` when nothing is left in it. */
function setEn(n: SpaceNode, key: 'title' | 'contentHtml', value: string) {
  const en = { ...n.en };
  if (value) en[key] = value;
  else delete en[key];
  n.en = Object.keys(en).length ? en : undefined;
}


/** Where backups are kept: depends on where the app stores its data. */
function backupsHint(): string {
  const kind = storageKind();
  if (kind === 'desktop')
    return tr('Копия создаётся сама перед обновлением из шаблона, удалением и восстановлением. Хранятся в папке данных программы: {path}', {
      path: `${dataFolder()}\\backups`,
    });
  if (kind === 'browser') return tr('Копия создаётся сама перед обновлением из шаблона, удалением и восстановлением. Хранятся в этом браузере — чтобы не потерять работу, делайте «Экспорт».');
  return tr('Копия создаётся сама перед обновлением из шаблона, удалением и восстановлением. Файлы: data/backups/');
}

function on(root: HTMLElement, sel: string, type: string, fn: (e: Event) => void) {
  root.querySelector(sel)?.addEventListener(type, fn);
}

function num(el: HTMLInputElement, fallback: number): number {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
