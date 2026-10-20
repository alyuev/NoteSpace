// Builds the starter set shipped with the desktop app and the web version:
// the active space from data/ as it is, one demo space, and the pictures they use.
//
//   public/starter/index.json          { activeId, spaces: [id, …] }
//   public/starter/spaces/<id>.json
//   public/starter/images/<name>
//
// Run before a production build (npm run build:app / build:web do it). Usage:
//   node scripts/bundle-starter.mjs [spaceId …]     (default: the active space + a demo)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const data = path.join(root, 'data');
const out = path.join(root, 'public', 'starter');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const spaceFile = (id) => path.join(data, 'spaces', `${id}.json`);
const all = fs
  .readdirSync(path.join(data, 'spaces'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => readJson(path.join(data, 'spaces', f)));

let ids = process.argv.slice(2);
if (!ids.length) {
  const active = readJson(path.join(data, 'index.json')).activeId;
  if (!active || !fs.existsSync(spaceFile(active))) throw new Error('no active space in data/index.json');
  const demo = all.find((s) => s.templateId === 'demo') ?? all.find((s) => /демо/i.test(s.title));
  ids = [active, ...(demo && demo.id !== active ? [demo.id] : [])];
}

// Pictures referenced anywhere in the spaces ("image": "<name>").
const images = new Set();
const collect = (v) => {
  if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      if (k === 'image' && typeof x === 'string') images.add(x);
      else collect(x);
    }
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'spaces'), { recursive: true });
for (const id of ids) {
  const space = readJson(spaceFile(id));
  collect(space);
  fs.writeFileSync(path.join(out, 'spaces', `${id}.json`), JSON.stringify(space));
  console.log('space ', id, space.title);
}
fs.mkdirSync(path.join(out, 'images'), { recursive: true });
for (const name of images) {
  const src = path.join(data, 'images', name);
  if (!fs.existsSync(src)) {
    console.warn('missing image', name);
    continue;
  }
  fs.copyFileSync(src, path.join(out, 'images', name));
  console.log('image ', name);
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify({ activeId: ids[0], spaces: ids }, null, 2));
console.log('starter set →', path.relative(root, out));
