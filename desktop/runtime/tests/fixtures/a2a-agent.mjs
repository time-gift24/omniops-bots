// Independent protocol consumer: deliberately no project runtime/service/store imports.
import { AgentCard, ListTasksRequest, ListTasksResponse, SendMessageRequest, StreamResponse, Task, TaskPushNotificationConfig } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, ServiceParameters, withA2AExtensions, withA2AVersion } from '@a2a-js/sdk/client';

const receiptUri = 'urn:omniops:a2a:extension:delivery-receipt:v1';
const [url] = process.argv.slice(2);
let lastWire;
const factory = new ClientFactory({ transports: [new JsonRpcTransportFactory({
  async fetchImpl(input, init) {
    const response = await fetch(input, init);
    if (response.headers.get('content-type')?.includes('application/json')) lastWire = await response.clone().json();
    return response;
  },
})], preferredTransports: ['JSONRPC'] });
const client = await factory.createFromUrl(url);
const streams = new Map();
const options = (command = {}) => ({ serviceParameters: {
  ...ServiceParameters.create(withA2AVersion('1.0'), withA2AExtensions(receiptUri)),
  ...(command.extensions === false ? { 'A2A-Extensions': '' } : {}),
  Authorization: command.credential ?? 'Bearer fixture-owner',
} });
const request = command => SendMessageRequest.fromJSON({
  tenant: command.tenant ?? '',
  message: { messageId: command.messageId, role: 'ROLE_USER', parts: [{ data: command.input, mediaType: 'application/json' }] },
  ...(command.immediate === undefined ? {} : { configuration: { returnImmediately: command.immediate } }),
});
async function execute(command) {
  const opts = options(command);
  switch (command.operation) {
    case 'card': return AgentCard.toJSON(await client.getAgentCard(opts));
    case 'send': {
      const task = await client.sendMessage(request(command), opts);
      return { task: Task.toJSON(task), wire: lastWire };
    }
    case 'get': return { task: Task.toJSON(await client.getTask({ id: command.taskId, tenant: command.tenant ?? '' }, opts)), wire: lastWire };
    case 'cancel': return Task.toJSON(await client.cancelTask({ id: command.taskId, tenant: command.tenant ?? '' }, opts));
    case 'list': return ListTasksResponse.toJSON(await client.listTasks(ListTasksRequest.fromJSON({ ...command.params, tenant: command.tenant ?? '' }), opts));
    // Use the public transport to reach the Server rather than the Client's local capability guard.
    case 'unsupported-card': return client.transport.getExtendedAgentCard({ tenant: 'fixture' }, opts);
    case 'unsupported-push': return client.transport.createTaskPushNotificationConfig(TaskPushNotificationConfig.fromJSON({ tenant: 'fixture', taskId: command.taskId }), opts);
    case 'wrong-version': return client.transport.getTask({ tenant: 'fixture', id: command.taskId }, { serviceParameters: { ...opts.serviceParameters, 'A2A-Version': '9.0' } });
    case 'stream': {
      const events = [];
      for await (const event of client.sendMessageStream(request(command), opts)) events.push(StreamResponse.toJSON(event));
      return events;
    }
    case 'open-stream': {
      const controller = new AbortController();
      const stream = command.taskId
        ? client.resubscribeTask({ id: command.taskId, tenant: command.tenant ?? '' }, { ...opts, signal: controller.signal })
        : client.sendMessageStream(request(command), { ...opts, signal: controller.signal });
      streams.set(command.streamId, { stream, controller });
      try {
        const first = await stream.next();
        if (first.done) throw new Error('A2A stream ended before its Task snapshot');
        return StreamResponse.toJSON(first.value);
      } catch (error) {
        streams.delete(command.streamId);
        controller.abort();
        try { await stream.return(); } catch {}
        throw error;
      }
    }
    case 'read-stream': {
      const { stream } = streams.get(command.streamId);
      try { const events = []; for await (const value of stream) events.push(StreamResponse.toJSON(value)); return events; }
      finally { streams.delete(command.streamId); }
    }
    case 'disconnect-stream': {
      const { stream, controller } = streams.get(command.streamId);
      controller.abort();
      try { await stream.return(); } catch (error) { if (error.name !== 'AbortError') throw error; }
      streams.delete(command.streamId);
      return { disconnected: true };
    }
    case 'receipt': {
      // The SDK has no client method for the one project-specific extension.
      const card = await client.getAgentCard(opts);
      const endpoint = card.supportedInterfaces.find(value => value.protocolBinding === 'JSONRPC');
      const response = await fetch(endpoint.url, { method: 'POST', headers: { ...opts.serviceParameters, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: command.id, method: 'omniops/ConfirmTaskDelivery', params: {
          tenant: command.tenant ?? endpoint.tenant, taskId: command.taskId, resultSha256: command.resultSha256, receivedAt: command.receivedAt,
        } }),
      });
      return { ...await response.json(), responseExtensions: response.headers.get('A2A-Extensions') };
    }
    default: throw new Error('Unknown external Agent command');
  }
}
process.on('message', async ({ id, command }) => {
  try { process.send({ id, value: await execute(command) }); }
  catch (error) { process.send({ id, error: { name: error.name, reason: error.reason, code: error.envelopeCode ?? error.code, message: error.message, metadata: error.metadata, data: error.data } }); }
});
process.on('disconnect', () => process.exit(0));
process.send({ ready: true });
