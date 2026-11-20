import { findNode } from './selection.js';

const sample = [{ id: '0', title: '', children: [
  { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: '10', parentId: '1', title: 'Design & inspiration', children: [
      { id: '11', parentId: '10', title: 'Figma — your ideas, together', url: 'https://www.figma.com/' },
      { id: '12', parentId: '10', title: 'Awwwards', url: 'https://www.awwwards.com/' },
      { id: '13', parentId: '10', title: 'Design systems', children: [
        { id: '14', parentId: '13', title: 'Material Design', url: 'https://m3.material.io/' },
        { id: '15', parentId: '13', title: 'Apple Human Interface Guidelines', url: 'https://developer.apple.com/design/human-interface-guidelines/' }
      ] }
    ] },
    { id: '20', parentId: '1', title: 'Development', children: [
      { id: '21', parentId: '20', title: 'GitHub', url: 'https://github.com/' },
      { id: '22', parentId: '20', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
      { id: '23', parentId: '20', title: 'CSS-Tricks', url: 'https://css-tricks.com/' }
    ] },
    { id: '30', parentId: '1', title: 'Read later', children: [
      { id: '31', parentId: '30', title: 'A List Apart', url: 'https://alistapart.com/' },
      { id: '32', parentId: '30', title: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/' }
    ] },
    { id: '40', parentId: '1', title: 'Are.na', url: 'https://www.are.na/' }
  ] },
  { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [
    { id: '50', parentId: '2', title: 'Travel ideas', children: [
      { id: '51', parentId: '50', title: 'Atlas Obscura', url: 'https://www.atlasobscura.com/' },
      { id: '52', parentId: '50', title: 'Lonely Planet', url: 'https://www.lonelyplanet.com/' }
    ] }
  ] }
] }];
const STORAGE_PREFIX = 'bridge-demo-';
const TREE_KEY = `${STORAGE_PREFIX}tree`;

function createDemoStorage(storage) {
  function storedNames() {
    const names = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) && key !== TREE_KEY) {
        names.push(key.slice(STORAGE_PREFIX.length));
      }
    }
    return names;
  }

  function selectedNames(keys) {
    if (keys === null) return storedNames();
    return Array.isArray(keys) ? keys : [keys];
  }

  return {
    QUOTA_BYTES: 10 * 1024 * 1024,
    async get(keys = null) {
      return Object.fromEntries(selectedNames(keys).map(key => [
        key,
        JSON.parse(storage.getItem(`${STORAGE_PREFIX}${key}`) || 'null'),
      ]));
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) {
        storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
      }
    },
    async remove(keys) {
      for (const key of selectedNames(keys)) storage.removeItem(`${STORAGE_PREFIX}${key}`);
    },
    async getBytesInUse(keys = null) {
      const encoder = new TextEncoder();
      return selectedNames(keys).reduce((total, key) => {
        const storedKey = `${STORAGE_PREFIX}${key}`;
        const value = storage.getItem(storedKey);
        return value === null ? total : total + encoder.encode(storedKey + value).length;
      }, 0);
    },
  };
}

export function createDemoApi(storage = globalThis.localStorage) {
  const tree = JSON.parse(storage.getItem(TREE_KEY) || 'null') || structuredClone(sample);

  function find(id) {
    const node = findNode(tree, id);
    if (!node) throw new Error('Bookmark no longer exists.');
    return node;
  }

  function saveTree() {
    storage.setItem(TREE_KEY, JSON.stringify(tree));
  }

  return {
    bookmarks: {
      getTree: async () => structuredClone(tree),
      get: async id => [structuredClone(find(id))],
      getChildren: async id => structuredClone(find(id).children || []),
      update: async (id, changes) => {
        const bookmark = find(id);
        if (bookmark.url === undefined) throw new Error('Choose a bookmark to update.');
        if (changes.title !== undefined) bookmark.title = changes.title;
        if (changes.url !== undefined) bookmark.url = changes.url;
        saveTree();
        return structuredClone(bookmark);
      },
      create: async details => {
        const parent = find(details.parentId);
        if (!parent.children || parent.id === '0') throw new Error('Invalid destination');
        const node = {
          ...details,
          id: crypto.randomUUID(),
          ...(details.url === undefined ? { children: [] } : {}),
        };
        parent.children.splice(details.index ?? parent.children.length, 0, node);
        saveTree();
        return structuredClone(node);
      },
      remove: async id => {
        const node = find(id);
        if (node.children?.length) throw new Error('Folder is not empty.');
        const parent = find(node.parentId);
        parent.children = parent.children.filter(child => child.id !== id);
        saveTree();
      },
    },
    storage: { local: createDemoStorage(storage) },
  };
}
