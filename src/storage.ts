import { sampleSpace } from './core/sample';
import { urantiaSpace } from './core/templates/urantia';
import type { Space } from './core/types';
import { tr } from './i18n';

/**
 * Persistence through the dev server (see server/dataPlugin.ts): one JSON file per space in
 * `data/spaces/`, so the files can also be edited directly and their changes show up live.
 * Will be backed by Tauri file access in the desktop build; keep the surface small.
 */

export interface SpaceMeta {
  id: string;
  title: string;
  en?: { title?: string };
}

export interface BackupInfo {
  name: string;
  reason: string;
  time: number;
}

let metas: SpaceMeta[] = [];
let activeId = '';
/** Last content written/read per space, to skip no-op saves. */
const lastJson = new Map<string, string>();
/** Last file revision we know of per space, to tell our own writes from external edits. */
const lastRev = new Map<string, number>();
const pending = new Map<string, number>();
const SAVE_DELAY_MS = 300;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function put(space: Space) {
  const json = JSON.stringify(space);
  const { rev } = await api<{ rev: number }>(`/api/spaces/${space.id}`, { method: 'PUT', body: json, keepalive: true });
  lastJson.set(space.id, json);
  lastRev.set(space.id, rev);
}

function remember(space: Space, rev: number) {
  lastJson.set(space.id, JSON.stringify(space));
  lastRev.set(space.id, rev);
}

async function refreshList() {
  metas = (await api<SpaceMeta[]>('/api/spaces')).map(({ id, title, en }) => ({ id, title, ...(en ? { en } : {}) }));
}

// ---------- one-time migration from the old in-browser storage ----------

const MIGRATED_KEY = 'notespace.migrated-to-files.v1';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Uploads spaces kept in this browser's old storage that the files don't have yet. Once per browser. */
async function migrateLocal(): Promise<string | null> {
  if (readLocal(MIGRATED_KEY)) return null;
  let localActive: string | null = null;
  try {
    const idx = JSON.parse(readLocal('notespace.index.v1') ?? 'null') as { activeId: string; spaces: SpaceMeta[] } | null;
    const known = new Set(metas.map((m) => m.id));
    for (const m of idx?.spaces ?? []) {
      const raw = readLocal(`notespace.space.${m.id}`);
      if (!raw || known.has(m.id)) continue;
      await put(JSON.parse(raw) as Space);
    }
    localActive = idx?.activeId ?? null;
  } catch {
    // broken old data: nothing to migrate
  }
  try {
    localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    // will simply try again next time (known ids are skipped)
  }
  return localActive;
}

// ---------- public API ----------

/** Loads the list, migrates old browser data, seeds starter spaces if there are none; returns the active space. */
export async function initStorage(): Promise<Space> {
  await refreshList();
  const migratedActive = await migrateLocal();
  await refreshList();
  if (!metas.length) {
    await put({ ...sampleSpace(), templateId: 'demo' });
    const u: Space = { ...urantiaSpace(), templateId: 'urantia' };
    await put(u);
    activeId = u.id;
    await refreshList();
  }
  const index = await api<{ activeId?: string }>('/api/index').catch(() => ({ activeId: undefined }));
  const preferred = [index.activeId, migratedActive, activeId, metas[0]?.id].find((id) => id && metas.some((m) => m.id === id))!;
  const space = await loadSpace(preferred);
  return space!;
}

/** Spaces known on disk (kept in memory; refreshed on changes). */
export function listSpaces(): SpaceMeta[] {
  return metas;
}

export async function loadSpace(id: string): Promise<Space | null> {
  try {
    const { space, rev } = await api<{ space: Space; rev: number }>(`/api/spaces/${id}`);
    remember(space, rev);
    return space;
  } catch {
    return null;
  }
}

/** Saves (debounced, skipped when unchanged), registers the space in the list and makes it active. */
export function saveSpace(space: Space) {
  const i = metas.findIndex((m) => m.id === space.id);
  if (i >= 0) metas[i] = { id: space.id, title: space.title, ...(space.en ? { en: space.en } : {}) };
  else metas.push({ id: space.id, title: space.title, ...(space.en ? { en: space.en } : {}) });
  if (activeId !== space.id) {
    activeId = space.id;
    void api('/api/index', { method: 'PUT', body: JSON.stringify({ activeId }) }).catch(() => undefined);
  }
  if (lastJson.get(space.id) === JSON.stringify(space)) return;
  clearTimeout(pending.get(space.id));
  // Serialise now: later in-memory edits are picked up by the next call.
  const snapshot = structuredClone(space);
  pending.set(
    space.id,
    window.setTimeout(() => {
      pending.delete(space.id);
      void put(snapshot).catch((e) => console.error('NoteSpace: save failed', e));
    }, SAVE_DELAY_MS),
  );
}

/** Deletes a space (the server keeps a backup); returns the id of the space to show next. */
export async function deleteSpace(id: string): Promise<string | null> {
  clearTimeout(pending.get(id));
  await api(`/api/spaces/${id}`, { method: 'DELETE' });
  await refreshList();
  return metas[0]?.id ?? null;
}

/** Writes the current state to disk right away, then copies the file into the backups. */
export async function backupSpace(space: Space, reason: string): Promise<void> {
  clearTimeout(pending.get(space.id));
  pending.delete(space.id);
  if (lastJson.get(space.id) !== JSON.stringify(space)) await put(space);
  await api(`/api/spaces/${space.id}/backups`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export function listBackups(id: string): Promise<BackupInfo[]> {
  return api<BackupInfo[]>(`/api/spaces/${id}/backups`);
}

/** Restores a backup (the current state is backed up first). */
export async function restoreBackup(id: string, name: string): Promise<Space> {
  const { space, rev } = await api<{ space: Space; rev: number }>(`/api/spaces/${id}/restore`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  remember(space, rev);
  return space;
}

/**
 * Calls `cb` when a space file was changed on disk by someone else (edited by hand, by an
 * assistant, restored…). Our own saves are recognised by their revision and ignored.
 */
export function onExternalChange(cb: (id: string, removed: boolean) => void) {
  import.meta.hot?.on('notespace:changed', async (e: { id: string; rev: number; removed?: boolean }) => {
    if (!e.removed && lastRev.get(e.id) === e.rev) return;
    if (pending.has(e.id)) return; // we are about to overwrite it anyway
    await refreshList().catch(() => undefined);
    cb(e.id, !!e.removed);
  });
}

// ---------- pictures for node styles ----------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

/** URL of a stored picture. */
export function imageUrl(name: string): string {
  return `/api/images/${encodeURIComponent(name)}`;
}

/** Uploads a picture to `data/images/` under a new unique name and returns that name. */
export async function uploadImage(file: File): Promise<string> {
  const ext = IMAGE_EXT.exec(file.name)?.[1]?.toLowerCase();
  if (!ext) throw new Error(tr('Поддерживаются png, jpg, gif, webp и svg'));
  const name = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  const res = await fetch(imageUrl(name), { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
  if (!res.ok) throw new Error(res.status === 413 ? tr('Файл пустой или больше 8 МБ') : tr('Не удалось загрузить ({status})', { status: res.status }));
  return name;
}
