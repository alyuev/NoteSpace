import { group, link, note } from './build';
import { newId, SCHEMA_VERSION, type Link, type Space, type SpaceNode } from './types';

const img = (from: string, to: string, text: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="90"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="240" height="90" rx="10" fill="url(#g)"/><text x="16" y="56" font-family="Segoe UI" font-size="26" fill="white">${text}</text></svg>`,
  );

export function sampleSpace(): Space {
  const nodes: SpaceNode[] = [
    group({ id: 'proj', title: 'Проект А', level: 2, frame: { offset: -4, levelStep: 6 }, tags: ['work'] }),
    note({
      id: 'idea',
      parentId: 'proj',
      title: 'Идея',
      level: 0,
      style: { color: '#e0af68', shape: 'cone', size: 1 },
      contentHtml: `<img src="${img('#e0af68', '#f7768e', 'Идея')}"><p>Сделать <b>3D-базу знаний</b> с уровнями.</p>`,
    }),
    note({ id: 'research', parentId: 'proj', title: 'Исследование', level: 1, tags: ['research'] }),
    group({ id: 'tasks', parentId: 'proj', title: 'Задачи', level: 2, frame: { levelStep: 4 }, style: { color: '#9ece6a', shape: 'octahedron', size: 1 } }),
    note({ id: 't1', parentId: 'tasks', title: 'T1: модель данных', level: 0, tags: ['task'], style: { color: '#9ece6a', shape: 'box', size: 0.8 } }),
    note({ id: 't2', parentId: 'tasks', title: 'T2: раскладка', level: 1, tags: ['task', 'urgent'], style: { color: '#f7768e', shape: 'box', size: 0.8 } }),
    note({ id: 't3', parentId: 'tasks', title: 'T3: экспорт', level: 1, tags: ['task'], style: { color: '#9ece6a', shape: 'box', size: 0.8 } }),
    note({
      id: 'goalA',
      parentId: 'proj',
      title: 'Цель проекта',
      levelMode: 'global',
      level: 6,
      tags: ['goal'],
      style: { color: '#ff9e64', shape: 'torus', size: 1 },
      contentHtml: `<p style="color:#ff9e64">Глобальный уровень 6: стоит на «этаже целей», хотя лежит в группе.</p>`,
    }),
    group({ id: 'life', title: 'Личное', level: 0, frame: { levelStep: 5 }, style: { color: '#7dcfff', shape: 'octahedron', size: 1 } }),
    note({ id: 'health', parentId: 'life', title: 'Здоровье', level: 0, tags: ['goal'], style: { color: '#7dcfff', shape: 'sphere', size: 1 } }),
    note({ id: 'books', parentId: 'life', title: 'Книги', level: 1, tags: ['research'], style: { color: '#7dcfff', shape: 'cylinder', size: 1 } }),
    group({ id: 'money', parentId: 'life', title: 'Финансы', level: 1, frame: { levelStep: 3 }, style: { color: '#73daca', shape: 'octahedron', size: 1 } }),
    note({ id: 'budget', parentId: 'money', title: 'Бюджет', level: 0, style: { color: '#73daca', shape: 'box', size: 1 } }),
    note({ id: 'invest', parentId: 'money', title: 'Инвестиции', level: 1, tags: ['goal'], style: { color: '#73daca', shape: 'sphere', size: 1 } }),
    note({ id: 'inbox', title: 'Входящие', level: -1, style: { color: '#a9b1d6', shape: 'box', size: 1.2 } }),
    note({
      id: 'yearGoals',
      title: 'Годовые цели',
      levelMode: 'global',
      level: 6,
      tags: ['goal'],
      style: { color: '#ff9e64', shape: 'torus', size: 1.3 },
      contentHtml: `<h3>2026</h3><ul><li>Запустить NoteSpace</li><li>Здоровье</li></ul>`,
    }),
  ];

  const links: Link[] = [
    link('idea', 'research', { directed: true }),
    link('t2', 'goalA', { directed: true }),
    link('books', 'research'),
    link('yearGoals', 'goalA', { directed: true, label: 'включает' }),
    link('yearGoals', 'health', { directed: true }),
    link('budget', 'proj', { color: '#e0af68', label: 'финансирует' }),
    link('inbox', 'tasks'),
  ];

  return {
    id: newId(),
    schemaVersion: SCHEMA_VERSION,
    title: 'Демо-пространство',
    globalStep: 10,
    nodes,
    links,
    tags: [
      { id: 'work', name: 'работа', color: '#bb9af7' },
      { id: 'research', name: 'исследование', color: '#7aa2f7' },
      { id: 'task', name: 'задача', color: '#9ece6a' },
      { id: 'urgent', name: 'срочно', color: '#f7768e' },
      { id: 'goal', name: 'цель', color: '#ff9e64' },
    ],
  };
}
