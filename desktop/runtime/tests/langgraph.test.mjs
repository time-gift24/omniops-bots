import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { createBrowserAgent } from '../langgraph.ts';
import { createResources } from '../resources.mjs';

// The real graph still binds and executes tools. Only model generation and the
// external browser/MCP effects are replaced with deterministic local fixtures.
class ScriptedModel extends BaseChatModel {
  constructor(turns) { super({}); this.turns = turns; this.inputs = []; this.bindings = []; }
  _llmType() { return 'local-capabilities-fixture'; }
  bindTools(tools) { this.bindings.push(tools.map(tool => tool.name)); return this; }
  async _generate(messages) {
    this.inputs.push(messages);
    const tool_calls = this.turns[this.inputs.length - 1] ?? [];
    return { generations: [{ text: '', message: new AIMessage({ id: randomUUID(), content: tool_calls.length ? '' : 'Fixture completed.', tool_calls }) }] };
  }
}
const call = (name, args = {}, id = name) => ({ id, name, args, type: 'tool_call' });
const resultById = result => new Map(result.messages.filter(message => message.getType() === 'tool').map(message => [message.tool_call_id, message]));
async function writable(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory)) await writable(join(directory, entry));
}
async function fixture(t, { skills = true, toolIds = ['inspect_browser'] } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'omniops-bots-graph-'));
  t.after(async () => { await writable(homeDir); await rm(homeDir, { recursive: true, force: true }); });
  const resources = createResources({ homeDir });
  let skill;
  const write = (path, value) => resources.handle('skill_library_write', { id: skill.id, path, data: Buffer.from(value).toString('base64'), replace: true });
  if (skills) {
    skill = await resources.handle('skill_library_create', { name: 'fixed-reference', description: 'Read the nested immutable reference.' });
    await write('SKILL.md', '---\nname: fixed-reference\ndescription: Read the nested immutable reference.\n---\nRead references/nested/evidence.txt for the evidence.\n');
    await resources.handle('skill_library_mkdir', { id: skill.id, path: 'references' });
    await resources.handle('skill_library_mkdir', { id: skill.id, path: 'references/nested' });
    await write('references/nested/evidence.txt', 'ORIGINAL_FIXED_REFERENCE_BYTES\n');
  }
  const created = await resources.handle('agent_create', { configuration: {
    name: 'Graph fixture', description: 'Exercise actual tool boundaries.', instructions: 'Use selected capabilities.', toolIds, skillIds: skill ? [skill.id] : [], mcpServerIds: [],
  } });
  const snapshot = await resources.prepareSession({ sessionId: 'graph-test-session', agentId: created.id });
  const actions = [], events = [];
  const browser = { async inspect(args) { actions.push(['inspect', args]); return { title: 'Actual fixture browser' }; }, async refresh() { actions.push(['refresh']); } };
  const workspace = {
    async list() { actions.push(['list']); return []; },
    async read(name) { actions.push(['read', name]); return { name, code: 'original script', sha256: 'a'.repeat(64) }; },
    async save(input) { actions.push(['save', input]); return { name: input.name, sha256: 'a'.repeat(64) }; },
    async run(input) { actions.push(['run', input]); return { status: 'passed', stdout: '', stderr: '' }; },
  };
  const mcp = new DynamicStructuredTool({ name: 'mcp_fixture_lookup', description: 'A selected MCP fixture.', schema: z.object({ key: z.string() }),
    func: async ({ key }) => { actions.push(['mcp', key]); return 'Verified MCP result'; } });
  async function run(turns, { extraTools = [], snapshot: selectedSnapshot = snapshot, redact = String } = {}) {
    const model = new ScriptedModel(turns);
    const controller = new AbortController();
    const built = createBrowserAgent({ model, signal: controller.signal, workspace, browser, snapshot: selectedSnapshot,
      checkpointer: new MemorySaver(), extraTools, redact, onTool: event => events.push(event) });
    const config = { configurable: { thread_id: randomUUID() }, signal: controller.signal, recursionLimit: 12 };
    const result = await built.agent.invoke({ messages: [new HumanMessage('Exercise the selected capabilities.')] }, config);
    await built.drain();
    return { result, model, built, config };
  }
  return { homeDir, resources, skill, write, created, snapshot, actions, events, browser, workspace, mcp, run };
}

test('real graph presents only selected builtins, MCP tools and read-only Skill tools', async t => {
  const f = await fixture(t);
  const { model, result } = await f.run([[call('inspect_browser'), call('mcp_fixture_lookup', { key: 'selected' })], []], { extraTools: [f.mcp] });
  const expected = ['inspect_browser', 'mcp_fixture_lookup', 'ls', 'read_file', 'glob', 'grep'].sort();
  assert.ok(model.bindings.length >= 1);
  for (const names of model.bindings) assert.deepEqual([...names].sort(), expected);
  assert.deepEqual(f.actions.toSorted((a, b) => a[0].localeCompare(b[0])), [['inspect', {}], ['mcp', 'selected']]);
  assert.equal(model.inputs.length, 2);
  const initialPrompt = JSON.stringify(model.inputs[0]);
  assert.match(initialPrompt, /fixed-reference/u);
  assert.match(initialPrompt, /Read the nested immutable reference/u);
  assert.match(initialPrompt, /\/skills\/fixed-reference\/SKILL\.md/u);
  assert.match(resultById(result).get('mcp_fixture_lookup').content, /Verified MCP result/u);
});

test('unselected tools and implicit framework delegation cannot execute even when the model calls them', async t => {
  const f = await fixture(t);
  const marker = join(f.snapshot.directory, 'forbidden-shell-marker');
  const attempts = [
    call('task', { subagent_type: 'general-purpose', description: 'Use inspect_browser, then write a file.' }),
    call('write_file', { file_path: '/forbidden.txt', content: 'must not exist' }),
    call('edit_file', { file_path: '/existing.txt', old_string: 'ORIGINAL', new_string: 'ALTERED' }),
    call('delete', { file_path: '/existing.txt' }),
    call('execute', { command: `printf forbidden > '${marker}'` }),
    call('write_todos', { todos: [{ content: 'Unselected planning', status: 'pending' }] }),
    call('list_playwright_scripts'), call('read_playwright_script', { name: 'private' }),
    call('write_playwright_script', { name: 'unexpected', code: 'must not execute' }),
    call('run_playwright_script', { name: 'unexpected', sha256: 'a'.repeat(64) }),
    call('mcp_unselected_lookup', { key: 'private' }),
  ];
  await writeFile(join(f.snapshot.directory, 'existing.txt'), 'ORIGINAL');
  const { model, result } = await f.run([attempts, []]);
  assert.deepEqual(f.actions, []);
  assert.equal(model.inputs.length, 2, 'task must not invoke an implicit general-purpose child model');
  const outputs = resultById(result);
  for (const attempt of attempts) {
    assert.equal(outputs.get(attempt.id)?.status, 'error', attempt.name);
    assert.match(String(outputs.get(attempt.id)?.content), /未.*启用|not.*valid|unknown.*tool/iu, attempt.name);
  }
  assert.equal(await readFile(join(f.snapshot.directory, 'existing.txt'), 'utf8'), 'ORIGINAL');
  await assert.rejects(readFile(join(f.snapshot.directory, 'forbidden.txt')), { code: 'ENOENT' });
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Skill reads reach nested fixed resources but cannot expose other session or host files', async t => {
  const f = await fixture(t);
  const secret = 'fixture-session-credential-do-not-expose';
  await mkdir(join(f.snapshot.directory, 'automation'));
  await writeFile(join(f.snapshot.directory, 'automation/private.mjs'), secret);
  await writeFile(join(f.snapshot.directory, '.env'), secret);
  const outside = join(f.homeDir, 'host-secret.txt');
  await writeFile(outside, secret);
  const mount = f.snapshot.skills[0].mountPath;
  const reads = [
    call('read_file', { file_path: `${mount}/references/nested/evidence.txt` }, 'reference'),
    call('ls', { path: `${mount}/references` }, 'nested-list'),
    call('glob', { pattern: '**/*.txt', path: mount }, 'nested-glob'),
    call('grep', { pattern: 'ORIGINAL_FIXED_REFERENCE_BYTES', path: mount }, 'nested-grep'),
    call('read_file', { file_path: '/automation/private.mjs' }, 'automation'),
    call('read_file', { file_path: '/.env' }, 'dotenv'),
    call('read_file', { file_path: '/assembly.json' }, 'manifest'),
    call('read_file', { file_path: outside }, 'host'),
    call('read_file', { file_path: `${mount}/../../automation/private.mjs` }, 'traversal'),
    call('ls', { path: '/' }, 'root-list'),
    call('glob', { pattern: '**/*', path: '/' }, 'root-glob'),
    call('grep', { pattern: 'fixture-session', path: '/' }, 'root-grep'),
  ];
  const { model, result } = await f.run([reads, []]);
  const outputs = resultById(result);
  assert.match(JSON.stringify(outputs.get('reference').content), /ORIGINAL_FIXED_REFERENCE_BYTES/u);
  for (const id of ['nested-list', 'nested-glob', 'nested-grep']) assert.match(JSON.stringify(outputs.get(id).content), /nested|evidence/u, id);
  for (const id of ['automation', 'dotenv', 'manifest', 'host', 'traversal', 'root-list', 'root-glob', 'root-grep']) {
    assert.match(JSON.stringify(outputs.get(id)?.content), /permission denied|invalid path|must not contain/iu, id);
  }
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(model.inputs).includes(secret), false);
  assert.deepEqual(f.actions, []);
});

test('a restarted graph reads original snapshot bytes after its source Skill changes', async t => {
  const f = await fixture(t);
  const read = call('read_file', { file_path: `${f.snapshot.skills[0].mountPath}/references/nested/evidence.txt` });
  const first = await f.run([[read], []]);
  assert.match(JSON.stringify(resultById(first.result).get('read_file').content), /ORIGINAL_FIXED_REFERENCE_BYTES/u);
  await f.write('references/nested/evidence.txt', 'CHANGED_SOURCE_REFERENCE_BYTES');
  const reopened = createResources({ homeDir: f.homeDir });
  const restored = await reopened.prepareSession({ sessionId: f.snapshot.sessionId, agentId: f.created.id });
  const continued = await f.run([[read], []], { snapshot: restored });
  assert.match(JSON.stringify(resultById(continued.result).get('read_file').content), /ORIGINAL_FIXED_REFERENCE_BYTES/u);
  assert.equal(JSON.stringify(continued.model.inputs).includes('CHANGED_SOURCE_REFERENCE_BYTES'), false);
  const later = await reopened.prepareSession({ sessionId: 'later-graph-session', agentId: f.created.id });
  const next = await f.run([[read], []], { snapshot: later });
  assert.match(JSON.stringify(resultById(next.result).get('read_file').content), /CHANGED_SOURCE_REFERENCE_BYTES/u);
});

test('an empty capability selection exposes no filesystem or framework tools', async t => {
  const f = await fixture(t, { skills: false, toolIds: [] });
  const { model, result } = await f.run([[call('read_file', { file_path: '/assembly.json' })], []]);
  assert.ok(model.bindings.every(names => names.length === 0));
  assert.equal(resultById(result).get('read_file').status, 'error');
  assert.deepEqual(f.actions, []);
});

test('known credentials are removed from successful and failed builtin results before the next model turn', async t => {
  const f = await fixture(t);
  const secret = 'fixture-known-provider-credential';
  const redact = value => value.replaceAll(secret, '[redacted]');
  f.browser.inspect = async ({ url }) => {
    if (url === 'https://failure.example/') throw new Error(`failed with ${secret}`);
    return { title: `Echoed ${secret}`, nested: { text: secret } };
  };
  const { model, result } = await f.run([[call('inspect_browser'), call('inspect_browser', { url: 'https://failure.example/' }, 'failed')], []], { redact });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(model.inputs).includes(secret), false);
  assert.equal(JSON.stringify(f.events).includes(secret), false);
  assert.match(JSON.stringify(resultById(result).get('inspect_browser')), /\[redacted\]/u);
  assert.match(JSON.stringify(resultById(result).get('failed')), /\[redacted\]/u);
});
