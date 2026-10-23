import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { AIMessage } from '@langchain/core/messages';
import { FakeToolCallingModel } from 'langchain';
import { AgentCard, Extensions, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk';
import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { canonicalize } from 'json-canonicalize';
import { createA2AService } from '../../a2a/index.ts';
import { createDesktopRuntime } from '../../runtime.ts';
import { createResources } from '../../resources.ts';
import { openSqliteCheckpointer } from '../../execution/sqlite.ts';
import { RuntimeError } from '../../errors.ts';

const [directory] = process.argv.slice(2);
const receiptUri = 'urn:omniops:a2a:extension:delivery-receipt:v1';
const principalFor = callerId => ({ organizationId: 'fixture-org', callerId, installationId: 'fixture-installation' });
const owner = principal => `omniops-v1:${createHash('sha256').update(canonicalize([principal.organizationId, principal.callerId, principal.installationId])).digest('hex')}`;
const events = [];
class FixtureModel extends FakeToolCallingModel {
  bindTools() { return this; }
  async _generate(messages, options) {
    const input = JSON.parse(messages.findLast(value => value.getType() === 'human').content);
    events.push({ event: 'start', case: input.case });
    if (input.hold || ['cancel', 'interrupted'].includes(input.case)) {
      await new Promise(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', resolve, { once: true });
      });
      // Keep the actual model operation alive after cancellation, exercising real drain.
      await delay(250);
    } else if (input.delay) await delay(input.delay);
    events.push({ event: 'drained', case: input.case });
    const text = input.case === 'invalid-output' ? 'fixture output is not JSON' : JSON.stringify(input.value ?? (input.value === null ? null : { ok: true }));
    return { generations: [{ text, message: new AIMessage({ content: text }) }] };
  }
}
const runsDir = join(directory, 'runs');
await mkdir(directory, { recursive: true });
const resources = createResources({ homeDir: directory, runsDir });
const fixtureFile = join(directory, 'fixture-agent.json');
let agent;
try { agent = JSON.parse(await readFile(fixtureFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  agent = await resources.handle('agent_create', { configuration: {
    name: 'External A2A fixture', description: 'Generic JSON input and output.', instructions: 'Return one JSON value.', toolIds: [], skillIds: [], mcpServerIds: [],
  } });
  agent = { ...agent, source: 'official' };
  await writeFile(join(directory, '.omnimind-ops/agents', `${agent.id}.json`), JSON.stringify(agent));
  await writeFile(fixtureFile, JSON.stringify(agent));
}
const checkpoints = await openSqliteCheckpointer(join(directory, 'checkpoints.sqlite'));
const browser = { getState: () => ({}), subscribe() {}, forThread() { return this; }, async close() {} };
const runtime = await createDesktopRuntime({ resources, runsDir, browser, workspace: {}, checkpointer: checkpoints.checkpointer,
  modelName: 'local-a2a-fixture', modelFactory: () => new FixtureModel({}), timeoutMs: 60_000,
});
const app = express();
app.disable('x-powered-by');
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const card = AgentCard.fromJSON({
  name: 'A2A independent acceptance fixture', description: 'Test-only loopback endpoint.', version: agent.contentId,
  supportedInterfaces: [{ url: `${url}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'fixture' }],
  capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [{ uri: receiptUri, required: true, description: 'Durable delivery receipt.' }] },
  defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: [],
});
const service = await createA2AService({ directory: join(directory, 'a2a'), runtime,
  limits: { maxRequestBytes: 64 * 1024, maxTaskBytes: 128 * 1024, maxJsonDepth: 32, maxWaiters: 8, maxSubscriptions: 8 },
  async resolveEndpoint(context, tenant) {
    const principal = context.state.get('omniops.principal');
    if (principal?.callerId === 'sensitive') throw new Error('synthetic-private-dependency-body');
    if (tenant !== 'fixture' || principal?.organizationId !== 'fixture-org' || principal.installationId !== 'fixture-installation') throw new RuntimeError('forbidden', 'Fixture endpoint is unavailable.');
    return { agentId: agent.id, contentId: agent.contentId, card };
  },
});
function context({ user, extensions, requestedVersion }) {
  return new ServerCallContext({ user, requestedVersion, requestedExtensions: extensions,
    state: new Map([['omniops.principal', user?.principal], ['omniops.waitSignal', user?.waitSignal]]),
  });
}
const bootstrap = principalFor('owner');
const handler = await service.protocolFor(context({ user: { isAuthenticated: true, userName: owner(bootstrap), principal: bootstrap }, extensions: [receiptUri], requestedVersion: '1.0' }), 'fixture');
async function userBuilder(request) {
  const credential = request.header('Authorization');
  const principal = credential === 'Bearer fixture-owner' ? principalFor('owner') : credential === 'Bearer fixture-other' ? principalFor('other') : credential === 'Bearer fixture-sensitive' ? principalFor('sensitive') : undefined;
  const controller = new AbortController();
  request.res.once('close', () => { if (!request.res.writableEnded) controller.abort(); });
  return { isAuthenticated: Boolean(principal), userName: principal ? owner(principal) : '', principal, waitSignal: controller.signal };
}
app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
// Only the project receipt branches before the official standard dispatcher.
app.use('/a2a', express.json({ limit: '64kb' }), async (request, response, next) => {
  if (request.body?.method !== 'omniops/ConfirmTaskDelivery') return next();
  try {
    const user = await userBuilder(request);
    const ctx = context({ user, extensions: Extensions.parseServiceParameter(request.header('A2A-Extensions')), requestedVersion: request.header('A2A-Version') });
    validateVersion(ctx.requestedVersion, card, 'JSONRPC');
    ctx.setTenant(request.body.params.tenant);
    const result = await service.confirmTaskDelivery(request.body.params, ctx);
    if (ctx.activatedExtensions) response.setHeader(HTTP_EXTENSION_HEADER, Array.from(ctx.activatedExtensions));
    response.json({ jsonrpc: '2.0', id: request.body.id, result });
  } catch (error) { response.json({ jsonrpc: '2.0', id: request.body.id, error: JsonRpcTransportHandler.mapToJSONRPCError(error) }); }
});
app.use('/a2a', jsonRpcHandler({ requestHandler: handler, userBuilder, contextBuilder: context }));
process.on('message', async ({ id, command }) => {
  try {
    if (command === 'stats') process.send({ id, value: { events, active: runtime.getState().tasks, records: runtime.dispatch('runs_list') } });
    if (command === 'close') {
      const deadline = performance.now() + 10_000;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await service.close({ deadline });
      await runtime.close({ deadline });
      await checkpoints.close();
      process.send({ id, value: { closed: true } }, () => process.disconnect());
    }
  } catch (error) { process.send({ id, error: { name: error.name, message: error.message } }); }
});
process.send({ ready: true, url });
