import { isReadOnly } from './bookmark-rules.js';

export function walk(nodes, visit, parent = null, depth = 0) {
  for (const node of nodes) {
    visit(node, parent, depth);
    if (node.children) walk(node.children, visit, node, depth + 1);
  }
}

export function countNodes(nodes) {
  const counts = { bookmarks: 0, folders: 0 };
  walk(nodes, node => {
    if (node.url === undefined) counts.folders++;
    else counts.bookmarks++;
  });
  return counts;
}

// Empty folders are selectable in their own right. Nonempty folders select their leaves.
export function selectableIds(node) {
  return node.children?.length ? node.children.flatMap(selectableIds) : [node.id];
}

export function selectedTree(nodes, selection) {
  const result = [];
  for (const node of nodes) {
    if (node.children?.length) {
      const children = selectedTree(node.children, selection);
      if (children.length) result.push({ ...node, children });
    } else if (selection.has(node.id)) {
      result.push(node.children ? { ...node, children: [] } : { ...node });
    }
  }
  return result;
}

export function findNode(nodes, id) {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children && findNode(node.children, id);
    if (child) return child;
  }
}

export function listFolders(tree) {
  const folders = [];
  function visit(nodes, parentPath, inheritedLock) {
    for (const node of nodes) {
      if (node.url !== undefined) continue;
      const locked = inheritedLock || isReadOnly(node);
      const path = node.title ? [...parentPath, node.title] : parentPath;
      if (node.id !== '0') folders.push({ id: node.id, label: path.join(' / ') || 'Untitled folder', locked });
      visit(node.children || [], path, locked);
    }
  }
  visit(tree, [], false);
  return folders;
}

const ROOT = Symbol('export root');
const FLAT = Symbol('flat export');

export function exportSelection(state) {
  let nodes = selectedTree(state.roots, state.chosen);
  if (!state.includeRoots) nodes = nodes.flatMap(node => node.children || [node]);
  if (!state.preserveFolders) {
    const bookmarks = [];
    walk(nodes, node => { if (node.url !== undefined) bookmarks.push(node); });
    nodes = bookmarks;
  }
  function arrange(siblings, parentKey) {
    const order = state.orders.get(parentKey);
    if (order) {
      const rank = new Map(order.map((id, index) => [id, index]));
      siblings.sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
    }
    for (const node of siblings) if (node.children) arrange(node.children, node.id);
  }
  arrange(nodes, state.preserveFolders ? ROOT : FLAT);
  return nodes;
}

export function moveExportItem(state, id, direction) {
  function move(siblings, parentKey) {
    const index = siblings.findIndex(node => node.id === id);
    if (index < 0) return siblings.some(node => node.children && move(node.children, node.id));
    const next = index + direction;
    if (next >= 0 && next < siblings.length) {
      [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
      state.orders.set(parentKey, siblings.map(node => node.id));
    }
    return true;
  }
  move(exportSelection(state), state.preserveFolders ? ROOT : FLAT);
}

export function moveImportItem(nodes, selection, id, direction) {
  const index = nodes.findIndex(node => node.id === id);
  if (index < 0) {
    return nodes.some(node => node.children && moveImportItem(node.children, selection, id, direction));
  }
  const visible = nodes.filter(node => selectableIds(node).some(key => selection.has(key)));
  const neighbor = visible[visible.findIndex(node => node.id === id) + direction];
  if (neighbor) {
    const next = nodes.indexOf(neighbor);
    [nodes[index], nodes[next]] = [nodes[next], nodes[index]];
  }
  return true;
}
