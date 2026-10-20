import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Dev-server storage for NoteSpace: spaces are JSON files on disk, so they can be edited both
 * by the app and directly (by hand or by an assistant), versioned with git, and backed up.
 *
 *   data/index.json              { activeId }
 *   data/spaces/<id>.json        one space per file (pretty-printed for readable diffs)
 *   data/backups/<id>/<stamp>--<reason>.json
 *   data/images/<name>           pictures for node styles (png, jpg, gif, webp, svg)
 *
 * API (JSON):
 *   GET    /api/spaces                    → [{ id, title, en?, rev }]
 *   GET    /api/spaces/:id                → { space, rev }
 *   PUT    /api/spaces/:id   body=space   → { rev }
 *   DELETE /api/spaces/:id                → {}            (backs up first)
 *   GET    /api/index | PUT /api/index    → { activeId }
 *   GET    /api/spaces/:id/backups        → [{ name, reason, time }]
 *   POST   /api/spaces/:id/backups        body={ reason } → { name }
 *   GET    /api/images/:name              → the image file
 *   POST   /api/images/:name      body=raw bytes  → { name }   (max 8 MB)
 *   POST   /api/spaces/:id/restore        body={ name }   → { space, rev }   (backs up current first)
 *
 * File changes on disk are pushed to the page as the HMR custom event `notespace:changed` { id, rev }.
 * `rev` is the file's modification time, so the page can ignore changes it wrote itself.
 */
export function notespaceData(dataDir = process.env.NOTESPACE_DATA_DIR ?? path.resolve('data')): Plugin {
  const spacesDir = path.join(dataDir, 'spaces');
  const backupsDir = path.join(dataDir, 'backups');
  const imagesDir = path.join(dataDir, 'images');
  const IMAGE_NAME = /^[A-Za-z0-9_-]{1,80}\.(png|jpe?g|gif|webp|svg)$/;
  const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const indexFile = path.join(dataDir, 'index.json');
  const ID = /^[A-Za-z0-9_-]{1,80}$/;

  const spaceFile = (id: string) => path.join(spacesDir, `${id}.json`);
  const rev = (file: string) => Math.round(fs.statSync(file).mtimeMs);

  function writeAtomic(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  }

  function backup(id: string, reason: string): string | null {
    const file = spaceFile(id);
    if (!fs.existsSync(file)) return null;
    const dir = path.join(backupsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeReason = reason.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'manual';
    const name = `${stamp}--${safeReason}.json`;
    fs.copyFileSync(file, path.join(dir, name));
    return name;
  }

  async function body(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  async function rawBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > limit) return null;
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function send(res: ServerResponse, status: number, data: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'spaces', id, sub]
    if (parts[0] !== 'api') return false;
    const method = req.method ?? 'GET';

    if (parts[1] === 'index' && parts.length === 2) {
      if (method === 'GET') return send(res, 200, fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {}), true;
      if (method === 'PUT') return writeAtomic(indexFile, await body(req)), send(res, 200, {}), true;
    }

    if (parts[1] === 'images' && parts.length === 3) {
      const name = parts[2];
      if (!IMAGE_NAME.test(name)) return send(res, 400, { error: 'bad image name' }), true;
      const file = path.join(imagesDir, name);
      if (method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' }), true;
        res.statusCode = 200;
        res.setHeader('Content-Type', IMAGE_TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(fs.readFileSync(file));
        return true;
      }
      if (method === 'POST') {
        const data = await rawBody(req, MAX_IMAGE_BYTES);
        if (!data || !data.length) return send(res, 413, { error: 'empty or too large' }), true;
        fs.mkdirSync(imagesDir, { recursive: true });
        fs.writeFileSync(file, data);
        return send(res, 200, { name }), true;
      }
    }

    if (parts[1] !== 'spaces') return false;
    if (parts.length === 2 && method === 'GET') {
      fs.mkdirSync(spacesDir, { recursive: true });
      const list = fs
        .readdirSync(spacesDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const file = path.join(spacesDir, f);
          try {
            const s = JSON.parse(fs.readFileSync(file, 'utf8'));
            return { id: s.id as string, title: s.title as string, ...(s.en ? { en: s.en } : {}), rev: rev(file) };
          } catch {
            return null; // half-written or broken file: skip
          }
        })
        .filter(Boolean);
      return send(res, 200, list), true;
    }

    const id = parts[2];
    if (!id || !ID.test(id)) return send(res, 400, { error: 'bad id' }), true;
    const file = spaceFile(id);

    if (parts.length === 3) {
      if (method === 'GET') {
        if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' }), true;
        return send(res, 200, { space: JSON.parse(fs.readFileSync(file, 'utf8')), rev: rev(file) }), true;
      }
      if (method === 'PUT') {
        const space = (await body(req)) as { id?: string };
        if (space.id !== id) return send(res, 400, { error: 'id mismatch' }), true;
        writeAtomic(file, space);
        return send(res, 200, { rev: rev(file) }), true;
      }
      if (method === 'DELETE') {
        backup(id, 'before-delete');
        if (fs.existsSync(file)) fs.unlinkSync(file);
        return send(res, 200, {}), true;
      }
    }

    if (parts[3] === 'backups') {
      const dir = path.join(backupsDir, id);
      if (method === 'GET') {
        const list = fs.existsSync(dir)
          ? fs
              .readdirSync(dir)
              .filter((f) => f.endsWith('.json'))
              .sort()
              .reverse()
              .map((name) => ({ name, reason: name.split('--')[1]?.replace(/\.json$/, '') ?? '', time: fs.statSync(path.join(dir, name)).mtimeMs }))
          : [];
        return send(res, 200, list), true;
      }
      if (method === 'POST') {
        const { reason } = (await body(req)) as { reason?: string };
        return send(res, 200, { name: backup(id, reason ?? 'manual') }), true;
      }
    }

    if (parts[3] === 'restore' && method === 'POST') {
      const { name } = (await body(req)) as { name?: string };
      const src = name && /^[\w.-]+\.json$/u.test(name) ? path.join(backupsDir, id, name) : '';
      if (!src || !fs.existsSync(src)) return send(res, 404, { error: 'backup not found' }), true;
      backup(id, 'before-restore');
      const space = JSON.parse(fs.readFileSync(src, 'utf8'));
      writeAtomic(file, space);
      return send(res, 200, { space, rev: rev(file) }), true;
    }

    return send(res, 404, { error: 'unknown route' }), true;
  }

  return {
    name: 'notespace-data',
    configureServer(server: ViteDevServer) {
      fs.mkdirSync(spacesDir, { recursive: true });
      server.middlewares.use((req, res, next) => {
        handle(req, res)
          .then((handled) => handled || next())
          .catch((e) => send(res, 500, { error: String(e) }));
      });
      // Tell the page when a space file changes on disk (by the app, by hand or by an assistant).
      server.watcher.add(spacesDir);
      const notify = (file: string) => {
        if (path.dirname(path.resolve(file)) !== path.resolve(spacesDir) || !file.endsWith('.json')) return;
        const id = path.basename(file, '.json');
        try {
          server.ws.send({ type: 'custom', event: 'notespace:changed', data: { id, rev: rev(file) } });
        } catch {
          server.ws.send({ type: 'custom', event: 'notespace:changed', data: { id, rev: 0, removed: true } });
        }
      };
      server.watcher.on('change', notify);
      server.watcher.on('add', notify);
      server.watcher.on('unlink', notify);
    },
  };
}
