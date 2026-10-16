import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUrl, parseBookmarkText, serializeHTML, serializeJSON, MAX_FILE_BYTES, MAX_DEPTH, MAX_NODES } from '../lib/formats.js';

const folder = (title, children = [], id) => ({ title, children, ...(id ? { id } : {}) });
const site = (title, url, id) => ({ title, url, ...(id ? { id } : {}) });
const content = nodes => nodes.map(({ id, ...node }) => ({ ...node, ...(node.children ? { children: content(node.children) } : {}) }));

test('Netscape HTML accepts optional DT/P endings and preserves nested folder order', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
  <TITLE>Bookmarks</TITLE><DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
      <DT><A HREF="https://example.com/a/?q=1&amp;x=2#frag" ADD_DATE="1700000000">A &amp; B</A>
      <DT><H3>Nested</H3><DL><p><DT><A HREF='mailto:hello@example.com'>Mail</A></DL><p>
      <DT><H3>Empty</H3><DL><p></DL><p>
    </DL><p>
    <DT><A HREF=https://outside.example/>Outside</A>
  </DL><p>`;
  const result = parseBookmarkText(html);
  assert.equal(result.format, 'html');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(content(result.nodes), [folder('Bookmarks bar', [
    { ...site('A & B', 'https://example.com/a/?q=1&x=2#frag'), dateAdded: 1700000000000 },
    folder('Nested', [site('Mail', 'mailto:hello@example.com')]), folder('Empty'),
  ]), site('Outside', 'https://outside.example/')]);
});

test('HTML attributes, markup text and numeric entities are parsed without executing scripts', () => {
  const html = `<DL><DT><H3>Folder &#x1F4DA;</H3></DT><DL>
    <DT><A href="https://example.com/?v=&quot;a&gt;b&quot;&amp;ok=1"><b>Read</b> &#38; learn<script>throw new Error('never'); <A HREF="https://fake.example/">fake</A></script></A></DT>
    <!-- <DT><A HREF="https://comment.example/">hidden</A> -->
    </DL></DL>`;
  const result = parseBookmarkText(html);
  assert.equal(result.nodes[0].title, 'Folder 📚');
  assert.deepEqual(content(result.nodes[0].children), [site('Read & learn', 'https://example.com/?v="a>b"&ok=1')]);
});

test('unsafe URLs are excluded with a warning and never normalized into allowed URLs', () => {
  const html = `<DL><DT><A HREF="javascript:alert(1)">Unsafe</A><DT><A HREF="java&#x09;script:alert(1)">Obfuscated</A>
    <DT><A HREF="data:text/html,test">Data</A><DT><A HREF="https://safe.example/path/?a=1#b">Safe</A></DL>`;
  const result = parseBookmarkText(html);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].url, 'https://safe.example/path/?a=1#b');
  assert.match(result.warnings[0], /Skipped 3 bookmarks/);
  for (const url of ['https://a.test/', 'http://a.test/', 'ftp://a.test/', 'file:///C:/notes.txt', 'mailto:a@example.com', 'chrome://newtab/', 'edge://favorites/', 'about:blank']) assert.ok(isAllowedUrl(url), url);
  for (const url of ['javascript:alert(1)', 'data:text/plain,hi', 'vbscript:x', 'unknown:hi', '/relative', 'https://', '', 'https:\n//a.test', 'https:example.com', 'https:/example.com', 'https:////example.com', 'https://example.com\\other']) assert.equal(isAllowedUrl(url), false, url);
});

test('HTML and app JSON round-trip order, empty folders, Unicode, escaping, URL distinctions and dates', () => {
  const nodes = [folder('研究 <&> "quotes"', [
    { ...site('A > B & "C"', 'https://example.com/path/?q=a&b=2#section'), dateAdded: 1700000000000 },
    site("O'Reilly", 'https://example.com/path'), site('Slash', 'https://example.com/path/'), folder('Empty'),
    folder('', [site('', 'https://empty-title.example/'), site('  Title with spaces  ', 'https://spaces.example/')]),
  ])];
  assert.deepEqual(content(parseBookmarkText(serializeHTML(nodes)).nodes), nodes);
  assert.deepEqual(content(parseBookmarkText(serializeJSON(nodes), 'bookmarks.json').nodes), nodes);
  assert.ok(serializeHTML(nodes).includes('&lt;&amp;&gt; &quot;quotes&quot;'));
});

test('valid empty HTML and JSON exports import successfully', () => {
  assert.deepEqual(parseBookmarkText(serializeHTML([])).nodes, []);
  assert.deepEqual(parseBookmarkText(serializeJSON([])).nodes, []);
  assert.deepEqual(parseBookmarkText('[]', 'tree.json').nodes, []);
});

test('Chrome getTree JSON unwraps only its synthetic root and preserves bookmark-bar folders', () => {
  const data = [{ id: '0', title: '', children: [folder('Bookmarks bar', [site('Site', 'https://example.com/', '2')], '1'), folder('Other bookmarks', [], '3')] }];
  const result = parseBookmarkText(JSON.stringify(data));
  assert.deepEqual(result.nodes, data[0].children);
});

test('Chromium disk Bookmarks imports all roots and converts the 1601 microsecond epoch', () => {
  const date = String(11644473600000000n + 1700000000123n * 1000n);
  const result = parseBookmarkText(JSON.stringify({ roots: {
    bookmark_bar: { name: 'Bookmarks bar', type: 'folder', id: '1', children: [{ name: 'Saved', type: 'url', id: '2', url: 'https://example.com/', date_added: date }] },
    other: { name: 'Other bookmarks', type: 'folder', id: '3', children: [] },
    synced: { name: '', type: 'folder', id: '4', children: [] },
  } }), 'Bookmarks');
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].children[0].dateAdded, 1700000000123);
  assert.equal(result.nodes[2].title, 'Mobile bookmarks');
});

test('duplicate and missing IDs are replaced without any collisions', () => {
  const result = parseBookmarkText(JSON.stringify([site('A', 'https://a.test/', 'same'), folder('B', [site('C', 'https://c.test/', 'import-1')], 'same'), site('D', 'https://d.test/')]));
  const ids = [result.nodes[0].id, result.nodes[1].id, result.nodes[1].children[0].id, result.nodes[2].id];
  assert.equal(new Set(ids).size, ids.length);
  assert.match(result.warnings.join(' '), /duplicate bookmark IDs/);
});

test('control characters in imported IDs are replaced so DOM data attributes remain stable', () => {
  const result = parseBookmarkText(JSON.stringify([
    site('NUL', 'https://a.test/', 'before\u0000after'),
    site('CRLF', 'https://b.test/', 'before\r\nafter'),
    site('Object property name', 'https://c.test/', '__proto__'),
    site('Markup-like ID', 'https://d.test/', '\"><script>alert(1)</script>'),
  ]));
  assert.ok(result.nodes.slice(0, 2).every(node => /^import-\d+$/.test(node.id)));
  assert.equal(result.nodes[2].id, '__proto__');
  assert.equal(result.nodes[3].id, '\"><script>alert(1)</script>');
  assert.equal(new Set(result.nodes.map(node => node.id)).size, 4);
});

test('unrecognized, empty, malformed and future format files fail clearly', () => {
  for (const text of ['', 'not bookmarks', '<html><body>Hello</body></html>', '<DL></DL>', '{}', '[1,2]', '{"roots":{}}', '{bad json']) {
    assert.throws(() => parseBookmarkText(text), undefined, text);
  }
  assert.throws(() => parseBookmarkText('{"format":"bookmark-bridge","version":2,"children":[]}'), /unsupported version/);
  assert.throws(() => parseBookmarkText('{"format":"bookmark-bridge","version":1}'), /children array/);
  assert.throws(() => parseBookmarkText('<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://example.com'), /incomplete tag/);
});

test('invalid JSON entries warn while valid neighbors survive', () => {
  const result = parseBookmarkText(JSON.stringify([null, {}, { title: 'Bad children', children: 'wrong' }, { title: 'Ambiguous', url: 'https://a.test/', children: [] }, site('Valid', 'https://safe.test/')]));
  assert.equal(result.nodes.length, 1);
  assert.match(result.warnings[0], /Skipped 4 invalid/);
});

test('file byte limit includes multibyte Unicode and limits exports too', () => {
  assert.throws(() => parseBookmarkText('x'.repeat(MAX_FILE_BYTES + 1)), /20 MB/);
  assert.throws(() => parseBookmarkText('汉'.repeat(Math.floor(MAX_FILE_BYTES / 3) + 1)), /20 MB/);
  assert.throws(() => serializeJSON([site('x'.repeat(MAX_FILE_BYTES), 'https://a.test/')]), /20 MB/);
});

test('depth and node limits reject oversized input before it can become an import plan', () => {
  let nodes = [site('Leaf', 'https://example.com/')];
  for (let index = 1; index < MAX_DEPTH; index++) nodes = [folder('Nested', nodes)];
  assert.equal(parseBookmarkText(JSON.stringify(nodes)).nodes.length, 1);
  assert.throws(() => parseBookmarkText(JSON.stringify([folder('Too deep', nodes)])), /100 folders/);
  assert.throws(() => parseBookmarkText(JSON.stringify(Array(MAX_NODES + 1).fill(null))), /100,000/);
});

test('serializers reject unsafe input and cycles instead of silently losing bookmarks', () => {
  assert.throws(() => serializeHTML([site('Unsafe', 'javascript:alert(1)')]), /unsafe URL/);
  assert.throws(() => serializeJSON([{ title: 'Invalid', children: null }]), /children array/);
  const cyclic = folder('Cycle');
  cyclic.children.push(cyclic);
  assert.throws(() => serializeJSON([cyclic]), /circular reference/);
});
