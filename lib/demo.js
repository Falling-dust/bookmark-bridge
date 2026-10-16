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
export function createDemoApi() {
  let tree = JSON.parse(localStorage.getItem('bridge-demo-tree') || 'null') || structuredClone(sample);
  const find = id => { let result; const visit = nodes => { for (const node of nodes) { if (node.id === id) result = node; if (node.children) visit(node.children); } }; visit(tree); if (!result) throw new Error('Bookmark no longer exists.'); return result; };
  const save = () => localStorage.setItem('bridge-demo-tree', JSON.stringify(tree));
  return {
    bookmarks: {
      getTree: async () => structuredClone(tree),
      get: async id => [structuredClone(find(id))],
      getChildren: async id => structuredClone(find(id).children || []),
      create: async details => { const parent = find(details.parentId); if (!parent.children || parent.id === '0') throw new Error('Invalid destination'); const node = { ...details, id: crypto.randomUUID(), ...(details.url === undefined ? { children: [] } : {}) }; parent.children.splice(details.index ?? parent.children.length, 0, node); save(); return structuredClone(node); },
      remove: async id => { const node = find(id); if (node.children?.length) throw new Error('Folder is not empty.'); const parent = find(node.parentId); parent.children = parent.children.filter(child => child.id !== id); save(); }
    },
    storage: { local: {
      QUOTA_BYTES: 10 * 1024 * 1024,
      get: async keys => {
        const names = keys === null ? Object.keys(localStorage).filter(key => key.startsWith('bridge-demo-') && key !== 'bridge-demo-tree').map(key => key.slice('bridge-demo-'.length)) : Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.map(key => [key, JSON.parse(localStorage.getItem(`bridge-demo-${key}`) || 'null')]));
      },
      set: async values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(`bridge-demo-${key}`, JSON.stringify(value)); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(`bridge-demo-${key}`); },
      getBytesInUse: async () => Object.entries(localStorage).filter(([key]) => key.startsWith('bridge-demo-') && key !== 'bridge-demo-tree').reduce((total, [key, value]) => total + new TextEncoder().encode(key + value).length, 0)
    } }
  };
}
