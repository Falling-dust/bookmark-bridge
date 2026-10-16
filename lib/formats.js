/** Local-only bookmark formats. No HTML is inserted into a document or executed. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DEPTH = 100;
export const MAX_NODES = 100000;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:', 'mailto:', 'chrome:', 'edge:', 'about:']);
const NETWORK_PROTOCOLS = new Set(['http:', 'https:', 'ftp:']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function isAllowedUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const candidate = value.trim();
  const scheme = /^([a-z][a-z\d+.-]*):/iu.exec(candidate);
  if (!scheme) return false;
  const protocol = scheme[0].toLowerCase();
  if (!ALLOWED_PROTOCOLS.has(protocol)) return false;
  const remainder = candidate.slice(scheme[0].length);
  if (NETWORK_PROTOCOLS.has(protocol) && !remainder.startsWith('//')) return false;
  if (remainder.startsWith('//')) {
    const authority = remainder.slice(2).split(/[/?#]/u, 1)[0];
    if (authority.includes('\\') || (NETWORK_PROTOCOLS.has(protocol) && !authority)) return false;
  }
  try { return new URL(candidate).protocol.toLowerCase() === protocol; }
  catch { return false; }
}

function checkSize(text) {
  if (text.length > MAX_FILE_BYTES || new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    throw new Error('Bookmark files must be 20 MB or smaller.');
  }
}

function decodeEntities(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity.toLowerCase()] ?? whole;
    const hex = entity[1].toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : '\ufffd';
  });
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function milliseconds(value, chromium = false) {
  if (value === undefined || value === null || value === '') return undefined;
  let result;
  if (chromium) {
    if (!/^[0-9]+$/.test(String(value))) return undefined;
    try { result = Number((BigInt(value) - 11644473600000000n) / 1000n); }
    catch { return undefined; }
  } else result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= 8640000000000000 ? Math.trunc(result) : undefined;
}

function normalizeNodes(input, { chromium = false, strict = false } = {}) {
  if (!Array.isArray(input)) throw new Error('The bookmark collection must be an array.');
  const ids = new Set();
  const active = new WeakSet();
  const counts = { unsafe: 0, invalid: 0, duplicate: 0 };
  let seen = 0;
  let sequence = 0;
  function invalid(message, kind = 'invalid') {
    if (strict) throw new Error(message);
    counts[kind]++;
  }
  function visit(entries, depth) {
    if (depth > MAX_DEPTH && entries.length) throw new Error('Bookmarks cannot be nested more than 100 folders deep.');
    const result = [];
    for (const entry of entries) {
      if (++seen > MAX_NODES) throw new Error('Bookmark files cannot contain more than 100,000 entries.');
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        invalid('A bookmark entry is not an object.');
        continue;
      }
      if (active.has(entry)) throw new Error('The bookmark collection contains a circular reference.');
      const hasUrl = Object.hasOwn(entry, 'url');
      const hasChildren = Object.hasOwn(entry, 'children');
      if (hasUrl && hasChildren) {
        invalid('A bookmark entry cannot have both a URL and children.');
        continue;
      }
      if (hasUrl && !isAllowedUrl(entry.url)) {
        invalid('A bookmark has an unsupported or unsafe URL.', 'unsafe');
        continue;
      }
      if (!hasUrl && !Array.isArray(entry.children)) {
        invalid('A folder must have a children array.');
        continue;
      }
      if (chromium && entry.type !== undefined && !['url', 'folder'].includes(entry.type)) {
        invalid('A Chromium bookmark has an unknown entry type.');
        continue;
      }
      const name = chromium ? (entry.name ?? entry.title) : entry.title;
      const title = typeof name === 'string' ? name : hasUrl ? entry.url.trim() : 'Untitled folder';
      let id = typeof entry.id === 'string' || (typeof entry.id === 'number' && Number.isFinite(entry.id)) ? String(entry.id) : '';
      // HTML attributes normalize CR/NUL characters. Regenerate these opaque IDs
      // so checkbox dataset values can always resolve back to the imported node.
      if (/[\u0000-\u001f\u007f]/u.test(id)) id = '';
      if (!id || ids.has(id)) {
        if (id) counts.duplicate++;
        do { id = `import-${++sequence}`; } while (ids.has(id));
      }
      ids.add(id);
      const node = { id, title };
      const dateAdded = milliseconds(chromium ? entry.date_added : entry.dateAdded, chromium);
      if (dateAdded !== undefined) node.dateAdded = dateAdded;
      if (hasUrl) node.url = entry.url.trim();
      else {
        active.add(entry);
        node.children = visit(entry.children, depth + 1);
        active.delete(entry);
      }
      result.push(node);
    }
    return result;
  }
  const nodes = visit(input, 1);
  const warnings = [];
  if (counts.unsafe) warnings.push(`Skipped ${counts.unsafe} bookmark${counts.unsafe === 1 ? '' : 's'} with unsupported or unsafe URLs.`);
  if (counts.invalid) warnings.push(`Skipped ${counts.invalid} invalid bookmark entr${counts.invalid === 1 ? 'y' : 'ies'}.`);
  if (counts.duplicate) warnings.push(`Replaced ${counts.duplicate} duplicate bookmark ID${counts.duplicate === 1 ? '' : 's'}.`);
  return { nodes, warnings };
}

function parseJSON(text) {
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('This JSON file is malformed. Choose a complete bookmark export.'); }
  let entries;
  let chromium = false;
  if (Array.isArray(data)) {
    entries = data;
    // getTree() includes the browser's synthetic root; actual bookmark folders stay intact.
    if (entries.length === 1 && String(entries[0]?.id) === '0' && entries[0]?.title === '' &&
        !Object.hasOwn(entries[0], 'url') && Array.isArray(entries[0].children)) entries = entries[0].children;
  } else if (data?.format === 'bookmark-bridge') {
    if (data.version !== 1) throw new Error('This Bookmark Bridge file uses an unsupported version.');
    if (!Array.isArray(data.children)) throw new Error('This Bookmark Bridge file has no children array.');
    entries = data.children;
  } else if (data && typeof data === 'object' && data.roots && typeof data.roots === 'object') {
    const rootNames = { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' };
    const keys = Object.keys(rootNames).filter(key => Object.hasOwn(data.roots, key));
    if (!keys.length) throw new Error('This Chromium file has no recognized bookmark roots.');
    entries = keys.map(key => {
      const root = data.roots[key];
      return root && typeof root === 'object' && !Array.isArray(root)
        ? { ...root, name: root.name || rootNames[key] } : root;
    });
    chromium = true;
  } else {
    throw new Error('Unsupported JSON format. Use a Bookmark Bridge export, a browser bookmark tree, or a Chromium Bookmarks file.');
  }
  const result = normalizeNodes(entries, { chromium });
  // A nonempty, wholly unrecognized JSON payload must not look like a valid empty export.
  if (entries.length && !result.nodes.length && !result.warnings.some(warning => warning.includes('unsafe URLs'))) {
    throw new Error('This JSON file contains no valid bookmark entries.');
  }
  return { ...result, format: 'json' };
}

/** A small inert tokenizer handles Netscape's optional DT/P closing tags without a DOM. */
function* htmlTokens(text) {
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('<', position);
    if (start === -1) { yield { type: 'text', value: text.slice(position) }; break; }
    if (start > position) yield { type: 'text', value: text.slice(position, start) };
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      position = end === -1 ? text.length : end + 3;
      continue;
    }
    let end = start + 1;
    let quote = '';
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end === text.length) {
      if (/^<\s*[a-z/!?]/i.test(text.slice(start))) {
        throw new Error('This bookmark HTML file has an incomplete tag. Choose a complete export.');
      }
      yield { type: 'text', value: text.slice(start) };
      break;
    }
    const inside = text.slice(start + 1, end);
    position = end + 1;
    const match = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)([\s\S]*)$/i.exec(inside);
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (match[1]) { yield { type: 'end', name }; continue; }
    const attrs = Object.create(null);
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    for (const attribute of match[3].matchAll(pattern)) {
      const key = attribute[1].toLowerCase();
      if (!Object.hasOwn(attrs, key)) attrs[key] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    // Ignore raw-text content, including apparent bookmark tags inside scripts or titles.
    if (['script', 'style', 'textarea', 'title'].includes(name)) {
      const closePattern = new RegExp(`<\\s*\\/\\s*${name}\\s*>`, 'gi');
      closePattern.lastIndex = position;
      const closing = closePattern.exec(text);
      position = closing ? closePattern.lastIndex : text.length;
      continue;
    }
    yield { type: 'start', name, attrs };
  }
}

function parseHTML(text) {
  const roots = [];
  const containers = [roots];
  let pendingFolder;
  let capture;
  let sawList = false;
  let sawEntry = false;
  let seen = 0;
  const current = () => containers[containers.length - 1];
  function finishCapture() {
    if (!capture) return;
    if (++seen > MAX_NODES) throw new Error('Bookmark files cannot contain more than 100,000 entries.');
    const title = decodeEntities(capture.text.join(''));
    const rawDate = capture.attrs.add_date;
    const dateAdded = rawDate && /^[0-9]+(?:\.[0-9]+)?$/.test(rawDate) ? milliseconds(Number(rawDate) * 1000) : undefined;
    const node = { title };
    if (dateAdded !== undefined) node.dateAdded = dateAdded;
    if (capture.name === 'h3') {
      node.children = [];
      pendingFolder = node;
    } else {
      node.url = capture.attrs.href;
      pendingFolder = undefined;
    }
    current().push(node);
    capture = undefined;
  }
  for (const token of htmlTokens(text)) {
    if (token.type === 'text') {
      if (capture) capture.text.push(token.value);
      continue;
    }
    if (token.type === 'start' && token.name === 'dl') {
      finishCapture();
      sawList = true;
      containers.push(pendingFolder ? pendingFolder.children : current());
      pendingFolder = undefined;
      if (containers.length > MAX_DEPTH + 2) throw new Error('Bookmarks cannot be nested more than 100 folders deep.');
    } else if (token.type === 'end' && token.name === 'dl') {
      finishCapture();
      pendingFolder = undefined;
      if (containers.length > 1) containers.pop();
    } else if (token.type === 'start' && ['h3', 'a'].includes(token.name)) {
      finishCapture();
      pendingFolder = undefined;
      sawEntry = true;
      capture = { name: token.name, attrs: token.attrs, text: [] };
    } else if (token.type === 'end' && token.name === capture?.name) finishCapture();
    else if (token.name === 'dt') {
      finishCapture();
      if (token.type === 'start') pendingFolder = undefined;
    }
  }
  finishCapture();
  if (!sawList || (!sawEntry && !/NETSCAPE-Bookmark-file-1/i.test(text))) {
    throw new Error('This is not a recognized bookmark HTML export. Export bookmarks from Chrome, Edge, or Firefox first.');
  }
  return { ...normalizeNodes(roots), format: 'html' };
}

export function parseBookmarkText(text, filename = 'bookmarks.html') {
  if (typeof text !== 'string') throw new Error('Bookmark file contents must be text.');
  checkSize(text);
  const content = text.replace(/^\ufeff/, '').trim();
  if (!content) throw new Error('The bookmark file is empty.');
  if (content[0] === '{' || content[0] === '[' || /\.json$/i.test(filename)) return parseJSON(content);
  return parseHTML(content);
}

export function serializeJSON(nodes) {
  const clean = normalizeNodes(nodes, { strict: true }).nodes;
  const output = JSON.stringify({ format: 'bookmark-bridge', version: 1, children: clean }, null, 2) + '\n';
  checkSize(output);
  return output;
}

export function serializeHTML(nodes) {
  const clean = normalizeNodes(nodes, { strict: true }).nodes;
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- Exported by Bookmark Bridge. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>',
  ];
  function write(entries, depth) {
    const indent = '    '.repeat(depth);
    for (const node of entries) {
      const date = node.dateAdded === undefined ? '' : ` ADD_DATE="${Math.floor(node.dateAdded / 1000)}"`;
      if (node.children) {
        lines.push(`${indent}<DT><H3${date}>${escapeHTML(node.title)}</H3>`, `${indent}<DL><p>`);
        write(node.children, depth + 1);
        lines.push(`${indent}</DL><p>`);
      } else lines.push(`${indent}<DT><A HREF="${escapeHTML(node.url)}"${date}>${escapeHTML(node.title)}</A>`);
    }
  }
  write(clean, 1);
  lines.push('</DL><p>', '');
  const output = lines.join('\n');
  checkSize(output);
  return output;
}
