/** Pure, non-destructive bookmark import planning. No browser APIs are used here. */
export const IMPORT_LIMITS = Object.freeze({ maxNodes: 100_000, maxDepth: 100 });

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:', 'mailto:', 'chrome:', 'edge:', 'about:']);
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ftp:']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Normalize scheme, hostname and default port without losing meaningful URL
 * differences. Trailing slashes, query order, tracking parameters and fragments
 * are retained. An empty HTTP(S)/FTP path is equivalent to `/`.
 */
export function normalizeUrl(url) {
  if (typeof url !== 'string') throw new TypeError('Bookmark URL must be a string.');
  const value = url.trim();
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Bookmark URL is empty or contains control characters.');
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(value);
  if (!scheme) throw new Error(`Bookmark URL must be absolute: ${value.slice(0, 120)}`);
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid bookmark URL: ${value.slice(0, 120)}`); }
  const protocol = scheme[0].toLowerCase();
  const remainder = value.slice(scheme[0].length);
  if (NETWORK_PROTOCOLS.has(protocol) && !remainder.startsWith('//')) {
    throw new Error(`Bookmark URL requires // after ${protocol}`);
  }
  if (!remainder.startsWith('//')) return protocol + remainder;
  const authorityEnd = remainder.slice(2).search(/[/?#]/u);
  const boundary = authorityEnd === -1 ? remainder.length : authorityEnd + 2;
  const authority = remainder.slice(2, boundary);
  if (authority.includes('\\')) throw new Error('Bookmark URL contains an ambiguous hostname.');
  const at = authority.lastIndexOf('@');
  const userInfo = at === -1 ? '' : authority.slice(0, at + 1);
  let suffix = remainder.slice(boundary);
  if (NETWORK_PROTOCOLS.has(protocol) && (!suffix || suffix.startsWith('?') || suffix.startsWith('#'))) suffix = '/' + suffix;
  return protocol + '//' + userInfo + parsed.host.toLowerCase() + suffix;
}

function importUrl(value) {
  const normalized = normalizeUrl(value);
  const protocol = normalized.slice(0, normalized.indexOf(':') + 1);
  if (!ALLOWED_PROTOCOLS.has(protocol)) throw new Error(`Unsupported or unsafe bookmark URL scheme: ${protocol}`);
  return { value: value.trim(), normalized };
}

function isLocked(node) {
  return Boolean(node.unmodifiable) || node.folderType === 'managed';
}

function appendToMap(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function inspectExistingTree(existingTree, collectMatches = false) {
  const roots = Array.isArray(existingTree) ? existingTree : [existingTree];
  const nodes = new Map();
  const containers = new Map();
  const urls = new Map();
  const localUrls = collectMatches ? new Map() : null;
  const seenObjects = new WeakSet();
  let count = 0;

  function visit(node, parent, inheritedLock, depth) {
    if (++count > IMPORT_LIMITS.maxNodes) throw new Error(`Existing bookmark tree exceeds ${IMPORT_LIMITS.maxNodes} nodes.`);
    if (depth > IMPORT_LIMITS.maxDepth) throw new Error(`Existing bookmark tree exceeds depth ${IMPORT_LIMITS.maxDepth}.`);
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Existing bookmark tree contains a malformed node.');
    if (seenObjects.has(node)) throw new Error('Existing bookmark tree contains a cycle or repeated node.');
    seenObjects.add(node);
    if (typeof node.id !== 'string' || !node.id || nodes.has(node.id)) throw new Error('Existing bookmark tree contains a missing or repeated ID.');
    const locked = inheritedLock || isLocked(node);
    const bookmark = own(node, 'url');
    if (bookmark && typeof node.url !== 'string') throw new Error('Existing bookmark tree contains a malformed URL.');
    if (bookmark && Array.isArray(node.children) && node.children.length) throw new Error('An existing bookmark cannot contain children.');
    nodes.set(node.id, { node, locked, bookmark });
    if (bookmark) {
      // Browser data can contain old/custom protocols. They may be considered
      // for duplicates, but are never recreated without import validation.
      let normalized;
      try { normalized = normalizeUrl(node.url); } catch { return; }
      const match = { existingId: node.id, title: node.title ?? '', ...(collectMatches ? { url: node.url, parentId: parent?.ref ?? node.parentId ?? '', locked } : {}) };
      if (!urls.has(normalized)) urls.set(normalized, match);
      if (parent && !parent.urls.has(normalized)) parent.urls.set(normalized, match);
      if (collectMatches) {
        appendToMap(localUrls, normalized, match);
        if (parent) appendToMap(parent.localUrls, normalized, match);
      }
      return;
    }
    if (own(node, 'children') && !Array.isArray(node.children)) throw new Error('Existing bookmark folder children must be an array.');
    const container = { ref: node.id, title: node.title ?? '', locked, existingId: node.id, folders: new Map(), urls: new Map(), ...(collectMatches ? { localUrls: new Map() } : {}) };
    containers.set(node.id, container);
    if (parent) appendToMap(parent.folders, container.title, container);
    for (const child of node.children ?? []) visit(child, container, locked, depth + 1);
  }
  for (const node of roots) visit(node, null, false, 0);
  return { nodes, containers, urls, localUrls };
}

function validateEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Import entries must be an array.');
  if (entries.length > IMPORT_LIMITS.maxNodes) throw new Error(`Import exceeds ${IMPORT_LIMITS.maxNodes} nodes.`);
  const active = new WeakSet();
  let count = 0;
  function visit(node, depth) {
    if (++count > IMPORT_LIMITS.maxNodes) throw new Error(`Import exceeds ${IMPORT_LIMITS.maxNodes} nodes.`);
    if (depth > IMPORT_LIMITS.maxDepth) throw new Error(`Import exceeds depth ${IMPORT_LIMITS.maxDepth}.`);
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Import contains a malformed bookmark or folder.');
    if (active.has(node)) throw new Error('Import contains a folder cycle.');
    if (typeof node.title !== 'string') throw new Error('Each imported bookmark or folder needs a text title.');
    active.add(node);
    if (own(node, 'url')) {
      if (own(node, 'children')) throw new Error('An imported bookmark cannot also contain children.');
      importUrl(node.url);
    } else {
      if (!Array.isArray(node.children)) throw new Error(`Imported folder "${node.title.slice(0, 80)}" needs a children array.`);
      for (const child of node.children) visit(child, depth + 1);
    }
    active.delete(node);
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.destinationId !== 'string' || !entry.destinationId) {
      throw new Error('Each import entry needs a destination folder ID.');
    }
    visit(entry.node, 0);
  }
}

/**
 * Return an ordered plan without mutating input data or existing bookmarks.
 * Create actions and explicitly reviewed update-bookmark actions perform writes. `parentRef` is
 * either an existing browser ID or the `key` of an earlier folder creation.
 * `index` is present only for insertion at the start. Informational merge/skip
 * actions are included so users can review every imported item.
 */
export function buildImportPlan({ entries, existingTree, duplicatePolicy = 'skip', duplicateScope = 'destination', duplicateDecisions = {}, mergeFolders = true, position = 'end' } = {}) {
  if (!['skip', 'keep', 'review'].includes(duplicatePolicy)) throw new Error('Duplicate policy must be "skip", "keep", or "review".');
  if (!['destination', 'global'].includes(duplicateScope)) throw new Error('Duplicate scope must be "destination" or "global".');
  if (!['start', 'end'].includes(position)) throw new Error('Import position must be "start" or "end".');
  if (typeof mergeFolders !== 'boolean') throw new TypeError('Folder merging must be true or false.');
  const reviewing = duplicatePolicy === 'review';
  if (reviewing && (!duplicateDecisions || typeof duplicateDecisions !== 'object' || Array.isArray(duplicateDecisions) ||
      ![null, Object.prototype].includes(Object.getPrototypeOf(duplicateDecisions)))) {
    throw new TypeError('Duplicate decisions must be a plain object.');
  }
  validateEntries(entries);
  const state = inspectExistingTree(existingTree, reviewing);
  for (const entry of entries) {
    if (entry.destinationId === '0') throw new Error('The browser root is not writable. Choose a bookmark folder.');
    const target = state.nodes.get(entry.destinationId);
    if (!target) throw new Error(`Destination folder no longer exists: ${entry.destinationId}`);
    if (target.bookmark) throw new Error('The import destination must be a folder, not a bookmark.');
    if (target.locked) throw new Error('The import destination is read-only or inside a managed folder.');
  }
  const actions = [];
  const conflicts = [];
  const stats = { bookmarks: 0, folders: 0, merged: 0, skipped: 0, ...(reviewing ? { updated: 0 } : {}) };
  const insertionCounts = new Map();
  const incomingKeys = new Set();
  let sequence = 0;
  function nextKey(create) {
    let key;
    do { key = `${create ? 'new' : 'review'}:${++sequence}`; } while (state.nodes.has(key));
    return key;
  }
  function insertion(parentRef) {
    if (position === 'end') return {};
    const index = insertionCounts.get(parentRef) ?? 0;
    insertionCounts.set(parentRef, index + 1);
    return { index };
  }
  function incomingKey(node, path) {
    const hasId = (typeof node.id === 'string' && node.id) || (typeof node.id === 'number' && Number.isFinite(node.id));
    const preferred = hasId ? `id:${node.id}` : `path:${path}`;
    // Format imports already have unique IDs; direct API callers may not.
    const key = incomingKeys.has(preferred) ? `path:${path}` : preferred;
    incomingKeys.add(key);
    return key;
  }
  function mergedTitle(local, incoming) {
    if (local === incoming) return local;
    const parts = [...new Set(local.split(' · ').map(part => part.trim()).filter(Boolean))];
    const seen = new Set(parts);
    const additions = [];
    for (const part of incoming.split(' · ').map(part => part.trim()).filter(Boolean)) {
      if (!seen.has(part)) { seen.add(part); additions.push(part); }
    }
    // Retain the exact stored title when the incoming title adds no information.
    return additions.length ? [...parts, ...additions].join(' · ') : local;
  }
  function addNode(node, parentRef, path) {
    const parent = state.containers.get(parentRef);
    if (!parent || parent.locked || parentRef === '0') throw new Error('Cannot write to this destination folder.');
    if (own(node, 'url')) {
      const { value: url, normalized } = importUrl(node.url);
      const duplicate = (duplicateScope === 'global' ? state.urls : parent.urls).get(normalized);
      let effectivePolicy = duplicatePolicy;
      let conflictKey;
      if (reviewing) {
        const identity = incomingKey(node, path);
        const hasDecision = own(duplicateDecisions, identity);
        // Keep stale decisions visible: losing a target must never silently turn
        // an explicit replacement into a creation or select a different target.
        if (duplicate || hasDecision) {
          conflictKey = identity;
          const records = (duplicateScope === 'global' ? state.localUrls : parent.localUrls).get(normalized) ?? [];
          const matches = records.map(record => ({ id: record.existingId, title: record.title, url: record.url, parentId: record.parentId, locked: record.locked }));
          const decision = hasDecision ? duplicateDecisions[identity] : null;
          const choice = decision && typeof decision === 'object' && !Array.isArray(decision) && own(decision, 'choice') &&
            ['skip', 'keep', 'replace', 'merge'].includes(decision.choice) ? decision.choice : null;
          const suppliedTarget = decision && typeof decision === 'object' && own(decision, 'targetId') && typeof decision.targetId === 'string' && decision.targetId ? decision.targetId : null;
          const defaultTarget = matches.find(match => !match.locked && match.parentId === parentRef) ?? matches.find(match => !match.locked) ?? matches.find(match => match.parentId === parentRef) ?? matches[0];
          const targetId = suppliedTarget ?? (choice === 'replace' || choice === 'merge' ? null : defaultTarget?.id ?? null);
          conflicts.push({ key: identity, incomingTitle: node.title, incomingUrl: url, parentRef, matches, choice, targetId });
          if (!choice) {
            actions.push({ type: 'unresolved', key: nextKey(false), parentRef, title: node.title, url, conflictKey, reason: 'Choose how to handle this overlapping bookmark.' });
            return;
          }
          if (choice === 'replace' || choice === 'merge') {
            const target = suppliedTarget ? records.find(record => record.existingId === suppliedTarget) : null;
            if (!target || target.locked || !target.parentId || target.parentId === '0') {
              actions.push({ type: 'unresolved', key: nextKey(false), parentRef, title: node.title, url, conflictKey, resolution: choice,
                ...(suppliedTarget ? { existingId: suppliedTarget } : {}), reason: 'Choose an existing, writable matching bookmark in the selected duplicate scope. The previous target may have changed or moved.' });
              return;
            }
            const before = { title: target.title, url: target.url, parentId: target.parentId };
            const title = choice === 'merge' ? mergedTitle(target.title, node.title) : node.title;
            const resultUrl = choice === 'merge' ? target.url : url;
            const changed = title !== target.title || resultUrl !== target.url;
            actions.push({ type: changed ? 'update-bookmark' : 'unchanged', key: nextKey(false), parentRef: target.parentId, existingId: target.existingId,
              title, url: resultUrl, before, resolution: choice, conflictKey });
            if (changed) {
              stats.updated++;
              // These records are private planning copies shared by the indexes.
              // Later conflicts and updates see the predicted preceding result.
              target.title = title;
              target.url = resultUrl;
            }
            return;
          }
          effectivePolicy = choice;
        }
      }
      if (effectivePolicy === 'skip' && (duplicate || conflictKey)) {
        actions.push({ type: 'skip', key: nextKey(false), parentRef, title: node.title, url,
          ...(duplicate?.existingId ? { existingId: duplicate.existingId } : {}), ...(conflictKey ? { conflictKey } : {}),
          reason: duplicate?.existingId ? `URL already exists ${duplicateScope === 'global' ? 'in the browser' : 'in this destination folder'}.` : duplicate ? 'URL is already included in this import.' : 'Skipped by your review decision.' });
        stats.skipped++;
        return;
      }
      const key = nextKey(true);
      actions.push({ type: 'create-bookmark', key, parentRef, title: node.title, url, ...insertion(parentRef), ...(conflictKey ? { conflictKey } : {}) });
      const match = { key, title: node.title };
      if (!state.urls.has(normalized)) state.urls.set(normalized, match);
      if (!parent.urls.has(normalized)) parent.urls.set(normalized, match);
      stats.bookmarks++;
      return;
    }
    const matches = mergeFolders ? parent.folders.get(node.title) ?? [] : [];
    let target = matches.find(folder => !folder.locked);
    if (!target && matches.length) throw new Error(`Cannot merge into read-only folder "${node.title.slice(0, 80)}". Turn off folder merging or choose another destination.`);
    if (target) {
      actions.push({ type: 'merge-folder', key: nextKey(false), parentRef, title: node.title,
        ...(target.existingId ? { existingId: target.existingId } : {}),
        reason: target.existingId ? 'Merge into the existing folder with this exact name.' : 'Merge into the folder already included in this import.' });
      stats.merged++;
    } else {
      const key = nextKey(true);
      actions.push({ type: 'create-folder', key, parentRef, title: node.title, ...insertion(parentRef) });
      target = { ref: key, title: node.title, locked: false, folders: new Map(), urls: new Map(), ...(reviewing ? { localUrls: new Map() } : {}) };
      state.containers.set(key, target);
      appendToMap(parent.folders, node.title, target);
      stats.folders++;
    }
    for (let index = 0; index < node.children.length; index++) addNode(node.children[index], target.ref, `${path}/${index}`);
  }
  for (let index = 0; index < entries.length; index++) addNode(entries[index].node, entries[index].destinationId, String(index));
  return { actions, stats, warnings: [], ...(reviewing ? { conflicts } : {}) };
}
