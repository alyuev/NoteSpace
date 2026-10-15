import type { GroupFrame, Link, SpaceNode } from './types';

/** Helpers for writing spaces in code (templates, demos, tests). */

export type NodeInit = Partial<Omit<SpaceNode, 'frame'>> & Pick<SpaceNode, 'id' | 'title'>;

export function note(init: NodeInit): SpaceNode {
  return {
    kind: 'note',
    parentId: null,
    contentHtml: `<p>${init.title}</p>`,
    tags: [],
    levelMode: 'local',
    level: 0,
    ...init,
    style: { color: '#7aa2f7', shape: 'sphere', size: 1, ...init.style },
  };
}

export function group(init: NodeInit & { frame?: Partial<GroupFrame> }): SpaceNode {
  const { frame, ...rest } = init;
  return {
    ...note({ ...rest, style: { color: '#bb9af7', shape: 'octahedron', size: 1, ...init.style } }),
    kind: 'group',
    frame: { offset: 0, levelStep: 6, collapsed: false, ...frame },
  };
}

export function link(from: string, to: string, extra: Partial<Link> = {}): Link {
  return { id: `${from}-${to}`, from, to, ...extra };
}
