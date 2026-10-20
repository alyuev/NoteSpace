import { mainColor, styleOf, type Space, type SpaceNode } from './core/types';
import { nodeTitle, tr } from './i18n';

/**
 * The one node picker used everywhere a node has to be chosen from the space: a text field with a
 * drop-down button. The button opens the full list; typing filters it to the titles that contain
 * every space-separated word (anywhere, any case). Groups are marked ▣ (in their colour, bold),
 * notes ●, the "none" entry ⌂.
 */
export interface NodeComboOptions {
  space: Space;
  /** Nodes to offer. */
  nodes: SpaceNode[];
  /** Currently chosen node id (null/undefined: none). */
  value?: string | null;
  /** Placeholder of the field (default: the "none" label, or "Название…"). */
  placeholder?: string;
  /** Label of the "none" entry (also the placeholder); without it the choice cannot be cleared. */
  emptyLabel?: string;
  /** Show at most this many matches (then a "… ещё N" line); default 300. */
  limit?: number;
  onChange: (id: string | null) => void;
  /** Ids offered as soon as the field is clicked (before anything is typed), in this order. */
  suggest?: () => string[];
}

const ICON_GROUP = '▣';
const ICON_NOTE = '●';
const ICON_NONE = '⌂';

function moreItem(rest: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'is-more';
  li.textContent = tr('… ещё {n}: уточните запрос', { n: rest });
  return li;
}

/** Builds the picker inside `host` (replacing its content). */
export function mountNodeCombo(host: HTMLElement, o: NodeComboOptions): void {
  host.classList.add('combo');
  const input = document.createElement('input');
  input.autocomplete = 'off';
  input.placeholder = o.placeholder ?? o.emptyLabel ?? tr('Название…');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'combo-btn';
  toggle.tabIndex = -1;
  toggle.title = tr('Открыть список');
  toggle.textContent = '▾';
  const list = document.createElement('ul');
  list.className = 'pick-list';
  list.hidden = true;
  host.replaceChildren(input, toggle, list);

  const titleOf = (id: string | null | undefined) => {
    const n = id ? (o.nodes.find((x) => x.id === id) ?? o.space.nodes.find((x) => x.id === id)) : undefined;
    return n ? nodeTitle(n) : '';
  };
  const resetInput = () => (input.value = titleOf(o.value));
  resetInput();

  /**
   * Fills the drop-down; with `filter`, keeps only titles that contain every typed word; with
   * `suggested`, shows just the suggested nodes (in their order).
   */
  const fill = (filter: boolean, suggested?: string[]) => {
    const words = filter ? input.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const pool = suggested
      ? suggested.map((id) => o.nodes.find((x) => x.id === id)).filter((x): x is SpaceNode => !!x)
      : o.nodes;
    const items: { id: string; title: string; group: boolean; color: string }[] = [
      ...(o.emptyLabel && !suggested ? [{ id: '', title: o.emptyLabel, group: false, color: '' }] : []),
      ...pool.map((x) => ({ id: x.id, title: nodeTitle(x), group: x.kind === 'group', color: mainColor(styleOf(o.space, x)) })),
    ];
    const matches = items.filter((it) => !it.id || words.every((w) => it.title.toLowerCase().includes(w)));
    const limit = o.limit ?? 300;
    const shown = matches.slice(0, limit);
    list.replaceChildren(
      ...shown
        .map((it) => {
          const li = document.createElement('li');
          li.dataset.id = it.id;
          li.className = `${it.id === (o.value ?? '') ? 'current ' : ''}${it.id ? (it.group ? 'is-group' : 'is-note') : 'is-root'}`;
          const icon = document.createElement('span');
          icon.className = 'pick-icon';
          icon.textContent = it.id ? (it.group ? ICON_GROUP : ICON_NOTE) : ICON_NONE;
          if (it.color) icon.style.color = it.color;
          const name = document.createElement('span');
          name.textContent = it.title;
          li.append(icon, name);
          return li;
        }),
      ...(matches.length > limit ? [moreItem(matches.length - limit)] : []),
    );
    list.hidden = false;
  };
  const close = () => {
    list.hidden = true;
    resetInput();
  };
  const choose = (id: string) => {
    list.hidden = true;
    o.value = id || null;
    resetInput();
    o.onChange(id || null);
  };

  input.addEventListener('focus', () => {
    input.select();
    // Suggestions right away (the field is about to be typed over).
    if (o.suggest) {
      const ids = o.suggest();
      if (ids.length) fill(false, ids);
    }
  });
  input.addEventListener('input', () => fill(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && !list.hidden) {
      const first = list.querySelector<HTMLElement>('li:not(.is-root):not(.is-more)') ?? list.querySelector<HTMLElement>('li:not(.is-more)');
      if (first) choose(first.dataset.id ?? '');
    }
  });
  toggle.addEventListener('click', () => (list.hidden ? fill(false) : close()));
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest('li');
    if (li && !li.classList.contains('is-more')) choose(li.dataset.id ?? '');
  });
  host.addEventListener('focusout', (e) => {
    if (!(e.relatedTarget instanceof Node && host.contains(e.relatedTarget))) setTimeout(close, 120);
  });
}
