import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
export const requireRuntime = createRequire(new URL('../runtime/package.json', import.meta.url));
export const RECEIPT = 'urn:omniops:a2a:extension:delivery-receipt:v1';
export const BINDING = 'urn:omniops:a2a:binding:wss-jsonrpc:v1';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
// Independent fixture implementation: never imports the client's hash or storage code.
export function packageDigest(files) {
  return sha256(canonical(files.map(item => item.kind === 'folder' ? { path: item.path, kind: 'folder' } : { path: item.path, kind: 'file', bytes: item.data.length, sha256: sha256(item.data) }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
export function resultDigest(task) {
  const { canonicalize } = requireRuntime('json-canonicalize');
  return sha256(canonicalize({ id: task.id, contextId: task.contextId, status: task.status, artifacts: task.artifacts ?? [] }));
}
export const isTerminal = task => ['TASK_STATE_COMPLETED','TASK_STATE_FAILED','TASK_STATE_CANCELED','TASK_STATE_REJECTED'].includes(task?.status?.state);
export function safePath(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || !value.isWellFormed() || value !== value.normalize('NFC') || value.includes('\\') || value.split('/').length > 32 || value.split('/').some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f<>:"|?*]/u.test(p) || /[. ]$/u.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p))) throw Object.assign(new Error('Invalid package path.'), { status: 422, code: 'invalid-package' });
  return value;
}
export const fail = (status, code) => Object.assign(new Error('Verification request could not be completed.'), { status, code });
