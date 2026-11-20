/** Rules shared by bookmark parsing, destination selection, and import planning. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DEPTH = 100;
export const MAX_NODES = 100_000;

const allowedProtocols = new Set(['http:', 'https:', 'ftp:', 'file:', 'mailto:', 'chrome:', 'edge:', 'about:']);
const networkProtocols = new Set(['http:', 'https:', 'ftp:']);

export function isAllowedBookmarkProtocol(protocol) {
  return allowedProtocols.has(protocol);
}

export function isNetworkProtocol(protocol) {
  return networkProtocols.has(protocol);
}

export function isReadOnly(node) {
  return Boolean(node.unmodifiable) || node.folderType === 'managed';
}
