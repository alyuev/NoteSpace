import { sampleSpace } from './core/sample';
import { urantiaSpace } from './core/templates/urantia';
import type { Space } from './core/types';
import { tr } from './i18n';

/**
 * Persistence of spaces, backups and pictures. One API for the app, three backends:
 *  - dev     — the dev server (server/dataPlugin.ts): JSON files in `data/`, edited live;
 *  - desktop — the Tauri app (src-tauri/src/lib.rs): the same files in the user's app data folder;
 *  - browser — the web version: IndexedDB in the visitor's browser.
 * The desktop app and the web version start from the starter set bundled in `starter/`
 * (built by scripts/bundle-starter.mjs).
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

export type StorageKind = 'dev' | 'desktop' | 'browser';

interface Backend {
  kind: StorageKind;
  list(): Promise<SpaceMeta[]>;
  get(id: string): Promise<{ space: Space; rev: number } | null>;
  /** Writes a space; returns its new revision. */
  put(space: Space): Promise<number>;
  remove(id: string): Promise<void>;
  getIndex(): Promise<{ activeId?: string }>;
  putIndex(index: { activeId: string }): Promise<void>;
  listBackups(id: string): Promise<BackupInfo[]>;
  backup(id: string, reason: string): Promise<void>;
  restore(id: string, name: string): Promise<{ space: Space; rev: number }>;
  imageUrl(name: string): string;
  saveImage(name: string, file: Blob): Promise<void>;
  /** Called once the backend is chosen (prepare paths, caches…). */
  init?(): Promise<void>;
}

const meta = (s: { id: string; title: string; en?: { title?: string } }): SpaceMeta => ({
  id: s.id,
  title: s.title,
  ...(s.en ? { en: s.en } : {}),
});

// ---------- dev: the dev server's file API ----------

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url}: ${res.status}`);
  return (await res.json()) as T;
}

const devBackend: Backend = {
  kind: 'dev',
  list: async () => (await api<SpaceMeta[]>('/api/spaces')).map(meta),
  get: (id) => api<{ space: Space; rev: number }>(`/api/spaces/${id}`).catch(() => null),
  put: async (space) => (await api<{ rev: number }>(`/api/spaces/${space.id}`, { method: 'PUT', body: JSON.stringify(space), keepalive: true })).rev,
  remove: async (id) => void (await api(`/api/spaces/${id}`, { method: 'DELETE' })),
  getIndex: () => api<{ activeId?: string }>('/api/index').catch(() => ({})),
  putIndex: async (index) => void (await api('/api/index', { method: 'PUT', body: JSON.stringify(index) })),
  listBackups: (id) => api<BackupInfo[]>(`/api/spaces/${id}/backups`),
  backup: async (id, reason) => void (await api(`/api/spaces/${id}/backups`, { method: 'POST', body: JSON.stringify({ reason }) })),
  restore: (id, name) => api<{ space: Space; rev: number }>(`/api/spaces/${id}/restore`, { method: 'POST', body: JSON.stringify({ name }) }),
  imageUrl: (name) => `/api/images/${encodeURIComponent(name)}`,
  saveImage: async (name, file) => {
    const res = await fetch(`/api/images/${encodeURIComponent(name)}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
    if (!res.ok) throw new Error(res.status === 413 ? tr('Файл пустой или больше 8 МБ') : tr('Не удалось загрузить ({status})', { status: res.status }));
  },
};

// ---------- desktop: Tauri commands ----------

const isTauri = () => '__TAURI_INTERNALS__' in window;

let tauriDataPath = '';
const tauriImages = new Set<string>();

function tauriBackend(): Backend {
  // Loaded lazily, so the web version does not depend on Tauri being present.
  const core = import('@tauri-apps/api/core');
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>) => (await core).invoke<T>(cmd, args);
  let convert: ((path: string) => string) | null = null;
  return {
    kind: 'desktop',
    async init() {
      tauriDataPath = await invoke<string>('data_path');
      convert = (await core).convertFileSrc;
      for (const name of await invoke<string[]>('list_images')) tauriImages.add(name);
    },
    list: async () => (await invoke<SpaceMeta[]>('list_spaces')).map(meta),
    get: async (id) => {
      const r = await invoke<{ space: string; rev: number } | null>('get_space', { id });
      return r ? { space: JSON.parse(r.space) as Space, rev: r.rev } : null;
    },
    put: (space) => invoke<number>('put_space', { id: space.id, json: JSON.stringify(space, null, 2) }),
    remove: (id) => invoke('delete_space', { id }),
    getIndex: async () => JSON.parse(await invoke<string>('get_index')) as { activeId?: string },
    putIndex: (index) => invoke('put_index', { json: JSON.stringify(index) }),
    listBackups: (id) => invoke<BackupInfo[]>('list_backups', { id }),
    backup: (id, reason) => invoke('backup_space', { id, reason }),
    restore: async (id, name) => {
      const r = await invoke<{ space: string; rev: number }>('restore_backup', { id, name });
      return { space: JSON.parse(r.space) as Space, rev: r.rev };
    },
    // Pictures saved by the app live in the data folder; starter pictures come with the app.
    imageUrl: (name) =>
      tauriImages.has(name) && convert ? convert(`${tauriDataPath}\\images\\${name}`) : `starter/images/${encodeURIComponent(name)}`,
    saveImage: async (name, file) => {
      if (file.size > 8 * 1024 * 1024) throw new Error(tr('Файл пустой или больше 8 МБ'));
      await invoke('save_image', { name, data: Array.from(new Uint8Array(await file.arrayBuffer())) });
      tauriImages.add(name);
    },
  };
}

// ---------- browser: IndexedDB ----------

const DB_NAME = 'notespace';
let dbPromise: Promise<IDBDatabase> | null = null;
const db = () =>
  (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}
const idbGet = <T>(key: string) => idb<T | undefined>('readonly', (s) => s.get(key));
const idbSet = (key: string, value: unknown) => idb<void>('readwrite', (s) => s.put(value, key));
const idbDel = (key: string) => idb<void>('readwrite', (s) => s.delete(key));
const idbKeys = (prefix: string) =>
  idb<IDBValidKey[]>('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'))).then((ks) => ks.map(String));

const browserImageUrls = new Map<string, string>();

const browserBackend: Backend = {
  kind: 'browser',
  async init() {
    // Pictures the visitor added: blob URLs, so `imageUrl` can stay synchronous.
    for (const key of await idbKeys('image:')) {
      const blob = await idbGet<Blob>(key);
      if (blob) browserImageUrls.set(key.slice(6), URL.createObjectURL(blob));
    }
  },
  async list() {
    const out: SpaceMeta[] = [];
    for (const key of await idbKeys('space:')) {
      const rec = await idbGet<{ json: string }>(key);
      if (rec) out.push(meta(JSON.parse(rec.json) as Space));
    }
    return out;
  },
  async get(id) {
    const rec = await idbGet<{ json: string; rev: number }>(`space:${id}`);
    return rec ? { space: JSON.parse(rec.json) as Space, rev: rec.rev } : null;
  },
  async put(space) {
    const rev = Date.now();
    await idbSet(`space:${space.id}`, { json: JSON.stringify(space), rev });
    return rev;
  },
  async remove(id) {
    await this.backup(id, 'before-delete');
    await idbDel(`space:${id}`);
  },
  getIndex: async () => (await idbGet<{ activeId?: string }>('index')) ?? {},
  putIndex: (index) => idbSet('index', index),
  async listBackups(id) {
    const keys = await idbKeys(`backup:${id}:`);
    return keys
      .map((k) => {
        const name = k.slice(`backup:${id}:`.length);
        const [stamp, reason = ''] = name.split('--');
        return { name, reason: reason.replace(/\.json$/, ''), time: Number(stamp) || 0 };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  },
  async backup(id, reason) {
    const rec = await idbGet<{ json: string }>(`space:${id}`);
    if (!rec) return;
    const safe = reason.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'manual';
    await idbSet(`backup:${id}:${String(Date.now()).padStart(13, '0')}--${safe}.json`, rec.json);
  },
  async restore(id, name) {
    const json = await idbGet<string>(`backup:${id}:${name}`);
    if (!json) throw new Error('backup not found');
    await this.backup(id, 'before-restore');
    const space = JSON.parse(json) as Space;
    return { space, rev: await this.put(space) };
  },
  imageUrl: (name) => browserImageUrls.get(name) ?? `starter/images/${encodeURIComponent(name)}`,
  async saveImage(name, file) {
    if (file.size > 8 * 1024 * 1024) throw new Error(tr('Файл пустой или больше 8 МБ'));
    await idbSet(`image:${name}`, file);
    browserImageUrls.set(name, URL.createObjectURL(file));
  },
};

// ---------- choosing a backend, starter set ----------

let backend: Backend = devBackend;

/** Dev server API reachable (npm run dev)? */
async function hasDevApi(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  try {
    return (await fetch('/api/index')).ok;
  } catch {
    return false;
  }
}

export function storageKind(): StorageKind {
  return backend.kind;
}

/** Folder with the desktop app's data (empty outside the desktop app). */
export function dataFolder(): string {
  return tauriDataPath;
}

/** Spaces of the starter set shipped with the app (empty if it is not there). */
async function loadStarter(): Promise<{ spaces: Space[]; activeId?: string }> {
  try {
    const index = (await (await fetch('starter/index.json')).json()) as { activeId?: string; spaces: string[] };
    const spaces: Space[] = [];
    for (const id of index.spaces) spaces.push((await (await fetch(`starter/spaces/${id}.json`)).json()) as Space);
    return { spaces, activeId: index.activeId };
  } catch {
    return { spaces: [] };
  }
}

// ---------- state shared by all backends ----------

let metas: SpaceMeta[] = [];
let activeId = '';
/** Last content written/read per space, to skip no-op saves. */
const lastJson = new Map<string, string>();
/** Last revision we know of per space, to tell our own writes from external edits. */
const lastRev = new Map<string, number>();
const pending = new Map<string, number>();
const SAVE_DELAY_MS = 300;

async function put(space: Space) {
  const json = JSON.stringify(space);
  const rev = await backend.put(space);
  lastJson.set(space.id, json);
  lastRev.set(space.id, rev);
}

function remember(space: Space, rev: number) {
  lastJson.set(space.id, JSON.stringify(space));
  lastRev.set(space.id, rev);
}

async function refreshList() {
  metas = await backend.list();
}

// ---------- one-time migration from the old in-browser storage (dev only) ----------

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

/**
 * Chooses the backend, fills an empty store (starter set in the app / web version, templates in
 * dev), and returns the active space.
 */
export async function initStorage(): Promise<Space> {
  backend = isTauri() ? tauriBackend() : (await hasDevApi()) ? devBackend : browserBackend;
  await backend.init?.();
  await refreshList();
  let migratedActive: string | null = null;
  if (backend.kind === 'dev') {
    migratedActive = await migrateLocal();
    await refreshList();
  }
  if (!metas.length) {
    const starter = backend.kind === 'dev' ? { spaces: [] as Space[] } : await loadStarter();
    if (starter.spaces.length) {
      for (const s of starter.spaces) await put(s);
      activeId = starter.activeId ?? starter.spaces[0].id;
    } else {
      await put({ ...sampleSpace(), templateId: 'demo' });
      const u: Space = { ...urantiaSpace(), templateId: 'urantia' };
      await put(u);
      activeId = u.id;
    }
    await refreshList();
  }
  const index = await backend.getIndex().catch(() => ({}) as { activeId?: string });
  const preferred = [index.activeId, migratedActive, activeId, metas[0]?.id].find((id) => id && metas.some((m) => m.id === id))!;
  // Remember the choice (a freshly filled store has no index yet), so a reload opens the same space.
  activeId = preferred;
  if (index.activeId !== preferred) await backend.putIndex({ activeId }).catch(() => undefined);
  return (await loadSpace(preferred))!;
}

/** Spaces known in the store (kept in memory; refreshed on changes). */
export function listSpaces(): SpaceMeta[] {
  return metas;
}

export async function loadSpace(id: string): Promise<Space | null> {
  try {
    const got = await backend.get(id);
    if (!got) return null;
    remember(got.space, got.rev);
    return got.space;
  } catch {
    return null;
  }
}

/** Saves (debounced, skipped when unchanged), registers the space in the list and makes it active. */
export function saveSpace(space: Space) {
  const i = metas.findIndex((m) => m.id === space.id);
  if (i >= 0) metas[i] = meta(space);
  else metas.push(meta(space));
  if (activeId !== space.id) {
    activeId = space.id;
    void backend.putIndex({ activeId }).catch(() => undefined);
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

/** Deletes a space (a backup is kept); returns the id of the space to show next. */
export async function deleteSpace(id: string): Promise<string | null> {
  clearTimeout(pending.get(id));
  await backend.remove(id);
  await refreshList();
  return metas[0]?.id ?? null;
}

/** Writes the current state right away, then copies it into the backups. */
export async function backupSpace(space: Space, reason: string): Promise<void> {
  clearTimeout(pending.get(space.id));
  pending.delete(space.id);
  if (lastJson.get(space.id) !== JSON.stringify(space)) await put(space);
  await backend.backup(space.id, reason);
}

export function listBackups(id: string): Promise<BackupInfo[]> {
  return backend.listBackups(id);
}

/** Restores a backup (the current state is backed up first). */
export async function restoreBackup(id: string, name: string): Promise<Space> {
  const { space, rev } = await backend.restore(id, name);
  remember(space, rev);
  return space;
}

/**
 * Calls `cb` when a space file was changed on disk by someone else (edited by hand, by an
 * assistant, restored…). Our own saves are recognised by their revision and ignored. Dev only:
 * the desktop app and the web version are the only writers of their stores.
 */
export function onExternalChange(cb: (id: string, removed: boolean) => void) {
  import.meta.hot?.on('notespace:changed', async (e: { id: string; rev: number; removed?: boolean }) => {
    if (backend.kind !== 'dev') return;
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
  return backend.imageUrl(name);
}

/** Stores a picture under a new unique name and returns that name. */
export async function uploadImage(file: File): Promise<string> {
  const ext = IMAGE_EXT.exec(file.name)?.[1]?.toLowerCase();
  if (!ext) throw new Error(tr('Поддерживаются png, jpg, gif, webp и svg'));
  if (!file.size) throw new Error(tr('Файл пустой или больше 8 МБ'));
  const name = `${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
  await backend.saveImage(name, file);
  return name;
}
