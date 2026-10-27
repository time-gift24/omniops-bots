import readline from 'node:readline';
import { join } from 'node:path';
import { exportOfflineThreadDiagnostics, listOfflineDiagnosticThreads, listSavedDiagnosticPackages, openSavedDiagnosticPackage, previewDiagnosticFile } from './diagnostics.ts';
import { invalid, safeError } from './errors.ts';
import { writeJson } from './json-store.ts';

/** Read-only diagnostic IPC mode. The native host owns the exclusive data-root lock.
 * Only status/list/export/shutdown are accepted; startup does not initialize or recover execution.
 */
export async function runDiagnosticIpc(localRoot: string): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const browser = { url: '', title: '', status: 'empty', canGoBack: false, canGoForward: false };
  const state = { simulated: false, diagnosticsOnly: true, tasks: [], task: null, browserThreadId: null, browser, operationsBrowser: browser, browserRequest: 0, connection: { state: 'offline', permissions: [] } };
  const finished = Promise.withResolvers<void>();
  let busy = false, closing = false;
  const controller = new AbortController();
  const stop = () => { closing = true; controller.abort(); input.close(); if (!busy) finished.resolve(); };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  for (const signal of signals) process.on(signal, stop);
  input.on('close', stop);
  input.on('line', line => {
    let request: { id: number; method: string; params?: Record<string, unknown> };
    try {
      if (Buffer.byteLength(line) > 65536) throw invalid('诊断请求超过大小限制。');
      request = JSON.parse(line);
      if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || typeof request.method !== 'string' || request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) throw invalid('诊断请求格式无效。');
    } catch (error) { send({ id: null, error: safeError(error) }); return; }
    if (request.method === 'shutdown') { send({ id: request.id, result: { stopped: true } }); stop(); return; }
    if (closing || busy) { send({ id: request.id, error: { kind: 'busy', message: '诊断操作正在进行。' } }); return; }
    busy = true;
    void (async () => {
      if (request.method === 'status') return state;
      if (request.method === 'diagnostic_saved_packages') return listSavedDiagnosticPackages(localRoot, { signal: controller.signal });
      if (request.method === 'diagnostic_open_package') return openSavedDiagnosticPackage(localRoot, request.params?.uploadId as string, { signal: controller.signal });
      if (request.method === 'diagnostic_preview_file') return previewDiagnosticFile(localRoot, request.params?.uploadId as string, request.params?.path as string, { signal: controller.signal });
      if (request.method === 'diagnostic_threads') return listOfflineDiagnosticThreads({ localRoot, cursor: request.params?.cursor as string | undefined, limit: request.params?.limit as number | undefined }, { signal: controller.signal });
      if (request.method === 'diagnostic_export') {
        const result = await exportOfflineThreadDiagnostics({ localRoot, threadId: request.params?.threadId as string, includeAttachments: request.params?.includeAttachments as string[] ?? [], outputDirectory: join(localRoot, 'diagnostics') }, { signal: controller.signal });
        await writeJson(join(localRoot, 'diagnostics', `${result.uploadId}.json`), result);
        return result;
      }
      throw invalid('独立诊断模式只提供只读材料导出。');
    })().then(result => send({ id: request.id, result }), error => send({ id: request.id, error: safeError(error) })).finally(() => { busy = false; if (closing) finished.resolve(); });
  });
  send({ event: 'ready', state });
  await finished.promise;
  for (const signal of signals) process.off(signal, stop);
}
