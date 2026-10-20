// Copies a space into the Urantia template: `node scripts/snapshot-template.mjs [space id]`
// (default: the active space from data/index.json). The template is then exactly that space,
// without its own id and template link; "Update from template" brings other spaces up to it.
import fs from 'node:fs';

const id = process.argv[2] ?? JSON.parse(fs.readFileSync('data/index.json', 'utf8')).activeId;
const space = JSON.parse(fs.readFileSync(`data/spaces/${id}.json`, 'utf8'));
delete space.id;
delete space.templateId;
fs.writeFileSync('src/core/templates/urantia.json', JSON.stringify(space) + '\n');
console.log(`template written from ${id}: ${space.nodes.length} nodes, ${space.links.length} links`);
