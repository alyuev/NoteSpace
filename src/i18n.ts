import type { NamedStyle, Space, SpaceNode, Tag } from './core/types';

/**
 * Interface language and translated texts.
 *
 * The interface is written in Russian; `tr` looks the Russian text up in the English dictionary
 * (`EN`) when English is on, and falls back to the Russian text if a line is missing. Placeholders
 * `{name}` are filled from `vars` in both languages.
 *
 * Content of a space (titles, descriptions, tag and style names) keeps its Russian text in the usual
 * fields and the English text in `en` (see the types); `nodeTitle` and friends pick the one for the
 * current language, again falling back to Russian.
 */
export type Lang = 'ru' | 'en';

const KEY = 'notespace.lang';

function load(): Lang {
  try {
    return localStorage.getItem(KEY) === 'en' ? 'en' : 'ru';
  } catch {
    return 'ru';
  }
}

export let lang: Lang = load();

/** Switches the language; the page reloads, so everything is built anew in it (the camera is remembered). */
export function setLang(next: Lang) {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage unavailable: the switch only lasts until the reload
  }
  lang = next;
  location.reload();
}

/** English for interface lines, keyed by the Russian text. Filled in `i18n-en.ts`. */
export const EN: Record<string, string> = {};

export function tr(ru: string, vars?: Record<string, string | number>): string {
  let s = lang === 'en' ? (EN[ru] ?? ru) : ru;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function nodeTitle(n: SpaceNode): string {
  return (lang === 'en' && n.en?.title) || n.title;
}

export function nodeContent(n: SpaceNode): string {
  return (lang === 'en' && n.en?.contentHtml) || n.contentHtml;
}

export function tagName(t: Tag): string {
  return (lang === 'en' && t.en) || t.name;
}

export function styleName(s: NamedStyle): string {
  return (lang === 'en' && s.en) || s.name;
}

export function spaceTitle(s: Space): string {
  return (lang === 'en' && s.en?.title) || s.title;
}
