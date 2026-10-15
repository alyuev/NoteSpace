import './style.css';
import type { TagFilter } from './core/filter';
import { computeLayout, SpaceIndex, type Layout } from './core/layout';
import { createFromTemplate, TEMPLATES, templateOf, updateFromTemplate } from './core/templates';
import { newId, type Arrange, type NamedStyle, type Shape, type Space, type SpaceNode } from './core/types';
import { loadSettings, saveSettings } from './settings';
import {
  backupSpace,
  deleteSpace,
  initStorage,
  listBackups,
  listSpaces,
  loadSpace,
  onExternalChange,
  restoreBackup,
  saveSpace,
} from './storage';
import { Viewer } from './viewer/viewer';

const LEVEL_HINT = `Уровень — высота узла в пространстве. Больше — выше, меньше — ниже; можно дробные и отрицательные значения (0.5, -2).

Локальный (по умолчанию): высота считается внутри родительской группы:
  Y = Y группы + смещение нуля группы + уровень × шаг уровня группы.
Уровень 0 — на пунктирном кольце группы, 1 — на один шаг выше, -1 — на шаг ниже. Двигаете группу — узел едет вместе с ней. В корне шаг = «Шаг глобального уровня» пространства.

Глобальный: Y = уровень × «Шаг глобального уровня» пространства — независимо от группы. Удобно, чтобы узлы из разных групп стояли на одном «этаже». Такой узел соединяется с группой пунктиром и не растягивает её оболочку.

Внутри вложенных групп шаг дополнительно уменьшается «Масштабом вложенных групп» (Настройки вида).`;
const LEVEL_MODE_HINT = `Локальный — высота относительно родительской группы (едет вместе с ней).
Глобальный — высота от общего нуля пространства, независимо от группы.`;

const SHAPES: Shape[] = ['sphere', 'box', 'cone', 'octahedron', 'torus', 'cylinder'];
const SHAPE_NAMES: Record<Shape, string> = {
  sphere: 'Сфера',
  box: 'Куб',
  cone: 'Конус',
  octahedron: 'Октаэдр',
  torus: 'Тор',
  cylinder: 'Цилиндр',
};

let space: Space = await initStorage();
let layout: Layout | undefined;
let filter: TagFilter = { tagIds: [], mode: 'any' };
let selectedId: string | null = null;

const left = document.getElementById('left')!;
const right = document.getElementById('right')!;
const settings = loadSettings();
const viewer = new Viewer(document.getElementById('stage')!);
viewer.setLinkOpacity(settings.linkOpacity);
viewer.setLabelDepthFade(settings.labelDepthFade);
viewer.setObjectDepthFade(settings.objectDepthFade);
viewer.labelZoom = settings.labelZoom;
viewer.labelScale = settings.labelScale;
viewer.labelShrink = settings.labelShrink;
viewer.showFrames = settings.showFrames;
viewer.showAxis = settings.showAxis;
viewer.onSelect = (id) => {
  selectedId = id;
  refresh(false);
};

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
  flash('Пространство обновлено с диска');
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

    <h2>Пространство</h2>
    <select id="spaceSelect">
      ${listSpaces()
        .map((m) => `<option value="${esc(m.id)}" ${m.id === space.id ? 'selected' : ''}>${esc(m.title)}</option>`)
        .join('')}
    </select>
    <div class="muted">${space.nodes.length} узлов · ${space.links.length} связей</div>
    <div class="row">
      <select id="templateSelect">${TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button id="newSpace">Создать</button>
    </div>

    <h2>Теги</h2>
    <div class="chips">
      ${space.tags
        .map(
          (t) =>
            `<button class="chip ${filter.tagIds.includes(t.id) ? 'on' : ''}" data-tag="${esc(t.id)}" style="--c:${esc(t.color)}">#${esc(t.name)}</button>`,
        )
        .join('')}
    </div>
    <div class="row">
      <label><input type="radio" name="mode" value="any" ${filter.mode === 'any' ? 'checked' : ''}> любой</label>
      <label><input type="radio" name="mode" value="all" ${filter.mode === 'all' ? 'checked' : ''}> все</label>
      <button id="clearFilter" ${filter.tagIds.length ? '' : 'disabled'}>Сбросить</button>
    </div>

    <h2>Создать</h2>
    <div class="row">
      <button id="addNote">+ Запись</button>
      <button id="addGroup">+ Группа</button>
    </div>
    <div class="muted">${esc(targetHint())}</div>

    <h2>Настройки вида</h2>
    <label>Яркость связей: <span id="linkOpacityValue">${Math.round(settings.linkOpacity * 100)}%</span>
      <input id="linkOpacity" type="range" min="0" max="100" step="1" value="${Math.round(settings.linkOpacity * 100)}">
    </label>
    <label title="Во сколько раз содержимое группы меньше самой группы — на каждом уровне вложенности (размер записей, шаг уровней, отступы)">Масштаб вложенных групп: <span id="depthScaleValue">${Math.round(settings.depthScale * 100)}%</span>
      <input id="depthScale" type="range" min="40" max="100" step="5" value="${Math.round(settings.depthScale * 100)}">
    </label>
    <label title="Во сколько раз уменьшается шрифт подписи на каждом уровне вложенности">Шрифт вложенных уровней: <span id="labelShrinkValue">${Math.round(settings.labelShrink * 100)}%</span>
      <input id="labelShrink" type="range" min="50" max="100" step="5" value="${Math.round(settings.labelShrink * 100)}">
    </label>
    <label>Размер подписей: <span id="labelScaleValue">${Math.round(settings.labelScale * 100)}%</span>
      <input id="labelScale" type="range" min="50" max="200" step="5" value="${Math.round(settings.labelScale * 100)}">
    </label>
    <label title="Подписи вдали от камеры тускнеют; при приближении к объекту его подписи становятся ярче">Затухание подписей вдали: <span id="labelFadeValue">${Math.round(settings.labelDepthFade * 100)}%</span>
      <input id="labelFade" type="range" min="0" max="100" step="1" value="${Math.round(settings.labelDepthFade * 100)}">
    </label>
    <label title="Удалённые от камеры объекты растворяются в фоне">Растворение объектов вдали: <span id="objectFadeValue">${Math.round(settings.objectDepthFade * 100)}%</span>
      <input id="objectFade" type="range" min="0" max="100" step="1" value="${Math.round(settings.objectDepthFade * 100)}">
    </label>
    <label class="check"><input id="labelZoom" type="checkbox" ${settings.labelZoom ? 'checked' : ''}> Подписи крупнее вблизи</label>
    <label class="check" title="Тонкая вертикальная линия через центр пространства"><input id="showAxis" type="checkbox" ${settings.showAxis ? 'checked' : ''}> Центральная ось</label>
    <label class="check" title="Пунктирное кольцо на высоте локального уровня 0 каждой группы"><input id="showFrames" type="checkbox" ${settings.showFrames ? 'checked' : ''}> Нулевой уровень групп</label>

    <h2>Управление</h2>
    <ul class="help">
      <li>ЛКМ — вращение, ПКМ — сдвиг, колесо — масштаб</li>
      <li>Клик — выбрать (по группе — ещё и перенести к ней центр), двойной клик — перенести центр к объекту, клик в пустоту — настройки пространства</li>
      <li>Задержите курсор на объекте ~1 с — появится его описание</li>
      <li>Пунктирное кольцо — нулевой уровень группы (её система отсчёта)</li>
      <li>Пунктирная линия — запись с глобальным уровнем внутри группы</li>
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
    settings.labelShrink = Number((e.target as HTMLInputElement).value) / 100;
    viewer.labelShrink = settings.labelShrink;
    left.querySelector('#labelShrinkValue')!.textContent = `${Math.round(settings.labelShrink * 100)}%`;
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
  on(left, '#labelZoom', 'change', (e) => {
    settings.labelZoom = (e.target as HTMLInputElement).checked;
    viewer.labelZoom = settings.labelZoom;
    saveSettings(settings);
  });
  on(left, '#showAxis', 'change', (e) => {
    settings.showAxis = (e.target as HTMLInputElement).checked;
    viewer.showAxis = settings.showAxis;
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
    const title = prompt('Название нового пространства', tpl.id === 'empty' ? 'Новое пространство' : tpl.name);
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
  return p ? `Будет создано в группе «${space.nodes.find((n) => n.id === p)!.title}»` : 'Будет создано в корне';
}

function addNode(kind: SpaceNode['kind']) {
  const node: SpaceNode = {
    id: newId(),
    kind,
    parentId: creationParent(),
    title: kind === 'group' ? 'Новая группа' : 'Новая запись',
    contentHtml: '<p>Текст записи</p>',
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
  const parentOptions = space.nodes.filter((g) => g.kind === 'group' && !idx.wouldCreateCycle(n.id, g.id));
  const links = space.links.filter((l) => l.from === n.id || l.to === n.id);
  const title = (id: string) => space.nodes.find((x) => x.id === id)?.title ?? '?';

  right.innerHTML = `
    <h2>${n.kind === 'group' ? 'Группа' : 'Запись'}</h2>
    <label>Название<input id="f-title" value="${esc(n.title)}"></label>
    <label>Родитель
      <select id="f-parent">
        <option value="">— корень —</option>
        ${parentOptions.map((g) => `<option value="${esc(g.id)}" ${idx.parentOf(n.id) === g.id ? 'selected' : ''}>${esc(g.title)}</option>`).join('')}
      </select>
    </label>

    <fieldset>
      <legend>Уровень <span class="hint" tabindex="0" title="${esc(LEVEL_HINT)}">?</span></legend>
      <div class="row">
        <select id="f-mode" title="${esc(LEVEL_MODE_HINT)}">
          <option value="local" ${n.levelMode === 'local' ? 'selected' : ''}>локальный</option>
          <option value="global" ${n.levelMode === 'global' ? 'selected' : ''}>глобальный</option>
        </select>
        <input id="f-level" type="number" step="0.5" value="${n.level}" title="${esc(LEVEL_HINT)}">
      </div>
      <div class="muted">${
        n.levelMode === 'local'
          ? idx.parentOf(n.id)
            ? 'Относительно системы отсчёта родительской группы'
            : 'В корне локальный = глобальный'
          : `Y = уровень × ${space.globalStep}, независимо от группы`
      }</div>
      <label class="check"><input id="f-center" type="checkbox" ${n.pinned ? 'checked' : ''}> Закрепить в центре ${idx.parentOf(n.id) ? 'группы' : 'сцены'}</label>
    </fieldset>

    ${
      n.kind === 'group'
        ? `<fieldset>
            <legend>Система отсчёта группы</legend>
            <label>Смещение нуля<input id="f-offset" type="number" step="0.5" value="${n.frame!.offset}"></label>
            <label>Шаг уровня<input id="f-step" type="number" step="0.5" min="0.5" value="${n.frame!.levelStep}"></label>
            <label>Расположение содержимого
              <select id="f-arrange">
                <option value="free" ${n.frame!.arrange !== 'ring' ? 'selected' : ''}>свободное</option>
                <option value="ring" ${n.frame!.arrange === 'ring' ? 'selected' : ''}>по кругу (закреплённые — в центре)</option>
              </select>
            </label>
            <label>Форма оболочки
              <select id="f-shell">
                <option value="ellipsoid" ${n.frame!.shell !== 'torus' ? 'selected' : ''}>эллипсоид</option>
                <option value="torus" ${n.frame!.shell === 'torus' ? 'selected' : ''}>тор (содержимое по кольцу, закреплённые в центре)</option>
              </select>
            </label>
            <label class="check" title="Содержимое сдвигается так, чтобы центр оболочки был на уровне самой группы"><input id="f-centerOnLevel" type="checkbox" ${n.frame!.centerOnLevel ? 'checked' : ''}> Центр оболочки — на уровне группы</label>
            <label class="check"><input id="f-collapsed" type="checkbox" ${n.frame!.collapsed ? 'checked' : ''}> Свернуть</label>
          </fieldset>`
        : ''
    }

    <fieldset>
      <legend>Вид</legend>
      <label>Стиль
        <select id="f-style">
          <option value="">— свой —</option>
          ${(space.styles ?? []).map((s) => `<option value="${esc(s.id)}" ${n.styleId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      ${
        n.styleId
          ? '<div class="muted">Цвет, форма и размер берутся из стиля. Изменить стиль — в настройках пространства (снимите выделение).</div>'
          : `<div class="row">
              <select id="f-shape">${SHAPES.map((s) => `<option value="${s}" ${n.style.shape === s ? 'selected' : ''}>${SHAPE_NAMES[s]}</option>`).join('')}</select>
              <input id="f-color" type="color" value="${esc(n.style.color)}">
              <input id="f-size" type="number" step="0.1" min="0.3" value="${n.style.size}" title="Размер">
            </div>
            <button id="f-saveStyle">Сохранить как новый стиль…</button>`
      }
      <label>Размер как
        <select id="f-sizeAs">
          <option value="">— собственный —</option>
          ${space.nodes
            .filter((x) => x.id !== n.id)
            .map((x) => `<option value="${esc(x.id)}" ${n.sizeAs === x.id ? 'selected' : ''}>${x.kind === 'group' ? '▣ ' : ''}${esc(x.title)}</option>`)
            .join('')}
        </select>
      </label>
    </fieldset>

    <fieldset>
      <legend>Теги</legend>
      <div class="chips">
        ${space.tags
          .map(
            (t) =>
              `<label class="chip ${n.tags.includes(t.id) ? 'on' : ''}" style="--c:${esc(t.color)}"><input type="checkbox" data-ntag="${esc(t.id)}" ${n.tags.includes(t.id) ? 'checked' : ''}>#${esc(t.name)}</label>`,
          )
          .join('')}
      </div>
    </fieldset>

    <label>Содержимое (HTML)<textarea id="f-html" rows="6">${esc(n.contentHtml)}</textarea></label>

    <fieldset>
      <legend>Связи</legend>
      <ul class="links">
        ${links
          .map(
            (l) =>
              `<li>${l.from === n.id ? '→' : '←'} ${esc(title(l.from === n.id ? l.to : l.from))}${l.label ? ` <i>(${esc(l.label)})</i>` : ''} <button data-unlink="${esc(l.id)}" title="Удалить связь">×</button></li>`,
          )
          .join('') || '<li class="muted">нет</li>'}
      </ul>
      <div class="row">
        <select id="l-target">${space.nodes
          .filter((x) => x.id !== n.id)
          .map((x) => `<option value="${esc(x.id)}">${x.kind === 'group' ? '▣ ' : ''}${esc(x.title)}</option>`)
          .join('')}</select>
      </div>
      <div class="row">
        <input id="l-label" placeholder="подпись">
        <label class="check"><input id="l-directed" type="checkbox" checked>→</label>
        <button id="l-add">Связать</button>
      </div>
    </fieldset>

    <button id="delete" class="danger">Удалить ${n.kind === 'group' ? 'группу (содержимое поднимется выше)' : 'запись'}</button>
  `;

  const edit = (sel: string, apply: (el: HTMLInputElement) => void, relayout = true) =>
    on(right, sel, 'change', (e) => {
      apply(e.target as HTMLInputElement);
      refresh(relayout);
    });

  edit('#f-title', (el) => (n.title = el.value.trim() || n.title));
  edit('#f-parent', (el) => {
    n.parentId = el.value || null;
    n.pinned = undefined;
  });
  edit('#f-mode', (el) => (n.levelMode = el.value as SpaceNode['levelMode']));
  edit('#f-level', (el) => (n.level = num(el, n.level)));
  edit('#f-offset', (el) => (n.frame!.offset = num(el, n.frame!.offset)));
  edit('#f-step', (el) => (n.frame!.levelStep = Math.max(0.5, num(el, n.frame!.levelStep))));
  edit('#f-collapsed', (el) => (n.frame!.collapsed = el.checked));
  edit('#f-arrange', (el) => (n.frame!.arrange = el.value as Arrange));
  edit('#f-shell', (el) => (n.frame!.shell = el.value === 'torus' ? 'torus' : undefined));
  edit('#f-centerOnLevel', (el) => (n.frame!.centerOnLevel = el.checked || undefined));
  edit('#f-center', (el) => (n.pinned = el.checked ? { x: 0, z: 0 } : undefined));
  edit('#f-style', (el) => (n.styleId = el.value || undefined));
  edit('#f-sizeAs', (el) => (n.sizeAs = el.value || undefined));
  on(right, '#f-saveStyle', 'click', () => {
    const name = prompt('Название стиля (например, «Ангелы»)')?.trim();
    if (!name) return;
    const style: NamedStyle = { id: newId(), name, ...n.style };
    space.styles = [...(space.styles ?? []), style];
    n.styleId = style.id;
    refresh(true);
  });
  edit('#f-shape', (el) => (n.style.shape = el.value as Shape), false);
  edit('#f-color', (el) => (n.style.color = el.value), false);
  edit('#f-size', (el) => (n.style.size = Math.max(0.3, num(el, n.style.size))));
  edit('#f-html', (el) => (n.contentHtml = el.value), false);
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
    const to = (right.querySelector('#l-target') as HTMLSelectElement).value;
    const label = (right.querySelector('#l-label') as HTMLInputElement).value.trim();
    const directed = (right.querySelector('#l-directed') as HTMLInputElement).checked;
    if (!to) return;
    space.links.push({ id: newId(), from: n.id, to, directed, ...(label ? { label } : {}) });
    refresh(true);
  });
  on(right, '#delete', 'click', () => {
    if (!confirm(`Удалить «${n.title}»?`)) return;
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
    <h2>Пространство</h2>
    <label>Название<input id="s-title" value="${esc(space.title)}"></label>
    <label>Шаг глобального уровня<input id="s-step" type="number" step="1" min="1" value="${space.globalStep}"></label>

    <label>Ближе к зрителю при открытии
      <select id="s-front">
        <option value="">— авто —</option>
        ${space.nodes.map((x) => `<option value="${esc(x.id)}" ${space.frontNodeId === x.id ? 'selected' : ''}>${x.kind === 'group' ? '▣ ' : ''}${esc(x.title)}</option>`).join('')}
      </select>
    </label>

    <fieldset>
      <legend>Шаблон</legend>
      <div class="row">
        <select id="s-template">
          ${TEMPLATES.filter((t) => t.id !== 'empty')
            .map((t) => `<option value="${t.id}" ${templateOf(space)?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`)
            .join('')}
        </select>
        <button id="s-update">Обновить из шаблона</button>
      </div>
      <div class="muted">Записи, связи, теги и стили шаблона заменятся текущей версией. Ваши собственные записи и связи сохранятся, но правки в записях шаблона будут потеряны.</div>
    </fieldset>

    <fieldset>
      <legend>Резервные копии</legend>
      <div class="row">
        <button id="b-make">Сделать копию</button>
        <button id="b-export" title="Скачать пространство файлом .json">Экспорт</button>
        <button id="b-import" title="Загрузить пространство из файла .json">Импорт…</button>
      </div>
      <ul class="links" id="b-list"><li class="muted">загрузка…</li></ul>
      <div class="muted">Копия создаётся сама перед обновлением из шаблона, удалением и восстановлением. Файлы: data/backups/</div>
    </fieldset>

    <fieldset>
      <legend>Теги</legend>
      <ul class="links">
        ${space.tags
          .map(
            (t) =>
              `<li><input type="color" data-tagcolor="${esc(t.id)}" value="${esc(t.color)}"><span style="color:${esc(t.color)}">#${esc(t.name)}</span><span class="muted">${usage(t.id)}</span><button data-deltag="${esc(t.id)}" title="Удалить тег">×</button></li>`,
          )
          .join('') || '<li class="muted">нет</li>'}
      </ul>
      <div class="row">
        <input id="t-name" placeholder="новый тег">
        <input id="t-color" type="color" value="#7aa2f7">
        <button id="t-add">Добавить</button>
      </div>
    </fieldset>

    <fieldset>
      <legend>Стили</legend>
      ${(space.styles ?? [])
        .map(
          (s) => `<div class="style-row">
            <div class="row">
              <input data-sname="${esc(s.id)}" value="${esc(s.name)}">
              <span class="muted" title="Узлов с этим стилем">${space.nodes.filter((n) => n.styleId === s.id).length}</span>
              <button data-sdel="${esc(s.id)}" title="Удалить стиль">×</button>
            </div>
            <div class="row">
              <select data-sshape="${esc(s.id)}">${SHAPES.map((sh) => `<option value="${sh}" ${s.shape === sh ? 'selected' : ''}>${SHAPE_NAMES[sh]}</option>`).join('')}</select>
              <input type="color" data-scolor="${esc(s.id)}" value="${esc(s.color)}">
              <input type="number" step="0.1" min="0.3" data-ssize="${esc(s.id)}" value="${s.size}" title="Размер">
            </div>
          </div>`,
        )
        .join('') || '<div class="muted">нет — создайте здесь или кнопкой «Сохранить как новый стиль» у записи</div>'}
      <div class="row">
        <input id="st-name" placeholder="новый стиль">
        <button id="st-add">Добавить</button>
      </div>
    </fieldset>

    <div class="muted">Выберите запись или группу в сцене, чтобы редактировать её.</div>
    <button id="s-delete" class="danger" ${listSpaces().length > 1 ? '' : 'disabled'}>Удалить пространство</button>
  `;

  bindBackups();
  on(right, '#s-update', 'click', () => {
    const tpl = TEMPLATES.find((t) => t.id === (right.querySelector('#s-template') as HTMLSelectElement).value)!;
    if (!confirm(`Обновить «${space.title}» из шаблона «${tpl.name}»?\nПравки в записях шаблона будут потеряны, ваши собственные записи сохранятся.`)) return;
    void backupSpace(space, 'before-template-update').then(() => {
      const { space: updated, keptNodes } = updateFromTemplate(space, tpl);
      switchTo(updated);
      flash(`Обновлено из шаблона. Резервная копия сохранена${keptNodes ? `, ваших записей сохранено: ${keptNodes}` : ''}.`);
    });
  });
  on(right, '#s-front', 'change', (e) => {
    space.frontNodeId = (e.target as HTMLSelectElement).value || undefined;
    viewer.resetView();
    refresh(false);
  });
  on(right, '#s-title', 'change', (e) => {
    space.title = (e.target as HTMLInputElement).value.trim() || space.title;
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
      if (usage(id) && !confirm(`Тег #${t.name} используется в ${usage(id)} узлах. Удалить?`)) return;
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
  bindStyle('sname', (s, el) => (s.name = el.value.trim() || s.name), false);
  bindStyle('sshape', (s, el) => (s.shape = el.value as Shape), false);
  bindStyle('scolor', (s, el) => (s.color = el.value), false);
  bindStyle('ssize', (s, el) => (s.size = Math.max(0.3, num(el, s.size))), true);
  right.querySelectorAll<HTMLButtonElement>('[data-sdel]').forEach((b) =>
    b.addEventListener('click', () => {
      const s = styleById(b.dataset.sdel!);
      const users = space.nodes.filter((n) => n.styleId === s.id);
      if (users.length && !confirm(`Стиль «${s.name}» используют ${users.length} узлов. Удалить? Они сохранят его вид как собственный.`)) return;
      for (const n of users) {
        n.style = { color: s.color, shape: s.shape, size: s.size };
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
    if (!confirm(`Удалить пространство «${space.title}» со всеми записями?`)) return;
    void deleteSpace(space.id)
      .then((nextId) => (nextId ? loadSpace(nextId) : null))
      .then((next) => next && switchTo(next));
  });
}

// ---------- backups, export, import ----------

function bindBackups() {
  const forId = space.id;
  const list = right.querySelector('#b-list') as HTMLElement;
  const fmt = (t: number) => new Date(t).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  const reasons: Record<string, string> = {
    manual: 'вручную',
    'before-template-update': 'перед обновлением из шаблона',
    'before-delete': 'перед удалением',
    'before-restore': 'перед восстановлением',
    'before-import': 'перед импортом',
  };
  const fill = () =>
    void listBackups(forId).then((items) => {
      if (space.id !== forId || !right.contains(list)) return; // panel was re-rendered meanwhile
      list.innerHTML =
        items
          .slice(0, 10)
          .map(
            (b) =>
              `<li><span>${esc(fmt(b.time))}</span><span class="muted">${esc(reasons[b.reason] ?? b.reason)}</span><button data-restore="${esc(b.name)}">Восстановить</button></li>`,
          )
          .join('') || '<li class="muted">пока нет</li>';
      list.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((btn) =>
        btn.addEventListener('click', () => {
          if (!confirm('Восстановить эту копию? Текущее состояние тоже сохранится в копию.')) return;
          void restoreBackup(forId, btn.dataset.restore!).then((s) => {
            switchTo(s);
            flash('Копия восстановлена');
          });
        }),
      );
    });
  fill();

  on(right, '#b-make', 'click', () => void backupSpace(space, 'manual').then(() => (fill(), flash('Копия сохранена'))));
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
        flash(`Импортировано: «${s.title}»`);
      } catch (e) {
        alert(`Не удалось импортировать файл: ${String(e)}`);
      }
    });
    input.click();
  });
}

/** Short non-blocking message at the bottom of the scene. */
function flash(text: string) {
  const el = document.createElement('div');
  el.className = 'flash';
  el.textContent = text;
  document.getElementById('stage')!.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- helpers ----------

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
