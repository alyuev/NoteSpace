import { sampleSpace } from '../sample';
import { newId, SCHEMA_VERSION, type Space } from '../types';
import { urantiaSpace } from './urantia';

export interface SpaceTemplate {
  id: string;
  name: string;
  create: () => Space;
}

export function emptySpace(): Space {
  return { id: newId(), schemaVersion: SCHEMA_VERSION, title: 'Новое пространство', globalStep: 10, nodes: [], links: [], tags: [] };
}

export const TEMPLATES: SpaceTemplate[] = [
  { id: 'empty', name: 'Пустое', create: emptySpace },
  { id: 'urantia', name: 'Книга Урантии', create: urantiaSpace },
  { id: 'demo', name: 'Демо: проект', create: sampleSpace },
];

export function createFromTemplate(tpl: SpaceTemplate): Space {
  return { ...tpl.create(), templateId: tpl.id };
}

/** Template a space most likely came from (spaces created before `templateId` existed are matched by title). */
export function templateOf(space: Space): SpaceTemplate | undefined {
  return TEMPLATES.find((t) => t.id === space.templateId) ?? TEMPLATES.find((t) => t.id !== 'empty' && t.name === space.title);
}

export interface TemplateUpdate {
  space: Space;
  /** User's own nodes (not from the template) that were kept. */
  keptNodes: number;
}

/**
 * Brings a space up to date with a template. Template items (matched by their fixed ids) are
 * replaced with the template's current version; everything the user added is kept.
 * Edits the user made to template items are lost.
 */
export function updateFromTemplate(space: Space, tpl: SpaceTemplate): TemplateUpdate {
  const fresh = tpl.create();
  // Template items keep their ids. Everything created in the app gets a UUID, so a UUID that is not
  // in the template is the user's own and is kept; items removed from the template disappear. (A
  // template made from a snapshot of a space contains UUIDs too: those count as template items.)
  const freshIds = new Set(fresh.nodes.map((n) => n.id));
  const own = (id: string, inTemplate: Set<string>) => isUserId(id) && !inTemplate.has(id);
  const ownNodes = space.nodes.filter((n) => own(n.id, freshIds)).map((n) => structuredClone(n));
  const nodes = [...fresh.nodes, ...ownNodes];
  const nodeIds = new Set(nodes.map((n) => n.id));
  // A user node whose parent no longer exists moves to the root.
  for (const n of ownNodes) if (n.parentId && !nodeIds.has(n.parentId)) n.parentId = null;

  const freshLinks = new Set(fresh.links.map((l) => l.id));
  const ownLinks = space.links.filter((l) => own(l.id, freshLinks) && nodeIds.has(l.from) && nodeIds.has(l.to));

  return {
    space: {
      ...space,
      schemaVersion: fresh.schemaVersion,
      globalStep: fresh.globalStep,
      templateId: tpl.id,
      frontNodeId: space.frontNodeId ?? fresh.frontNodeId,
      originNodeId: space.originNodeId ?? fresh.originNodeId,
      lightYearsPerUnit: space.lightYearsPerUnit ?? fresh.lightYearsPerUnit,
      nodes,
      links: [...fresh.links, ...ownLinks],
      tags: [...fresh.tags, ...space.tags.filter((t) => own(t.id, new Set(fresh.tags.map((x) => x.id))))],
      styles: [...(fresh.styles ?? []), ...(space.styles ?? []).filter((x) => own(x.id, new Set((fresh.styles ?? []).map((y) => y.id))))],
      en: fresh.en ?? space.en,
    },
    keptNodes: ownNodes.length,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUserId(id: string): boolean {
  return UUID.test(id);
}
