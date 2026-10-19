import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { STORAGE_KEY, createStore, exportMarkdown } = createRequire(import.meta.url)('./comments.js');
const comment = (values = {}) => ({ id: 'one', chapterId: '00-overview', chapterTitle: '00 客户端总体设计',
  text: '明确客户端边界', createdAt: '2026-10-19T09:00:00.000Z', updatedAt: '2026-10-19T09:00:00.000Z', ...values });
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('comments survive reload, edits replace records, and deleted comments can be restored', () => {
  const local = storage();
  const first = createStore(() => local);
  assert.equal(first.save(comment()), true);
  const second = createStore(() => local);
  assert.equal(second.comments[0].text, '明确客户端边界');
  assert.equal(second.save(comment({ text: '确认客户端边界', updatedAt: '2026-10-19T10:00:00.000Z' })), true);
  assert.equal(second.comments.length, 1);
  const deleted = second.comments[0];
  assert.equal(second.remove(deleted.id), true);
  assert.equal(createStore(() => local).comments.length, 0);
  second.save(deleted);
  assert.equal(createStore(() => local).comments[0].text, '确认客户端边界');
});

test('write failure preserves exportable in-memory records and can retry without duplication', () => {
  const local = storage(), original = local.setItem;
  const state = createStore(() => local);
  local.setItem = () => { throw new Error('quota'); };
  assert.equal(state.save(comment()), false);
  assert.equal(state.dirty, true);
  assert.match(state.error, /保存失败/);
  assert.equal(state.comments.length, 1);
  assert.match(exportMarkdown(state.comments), /明确客户端边界/);
  state.save(comment({ text: '补充意见' }));
  assert.equal(state.comments.length, 1);
  local.setItem = original;
  assert.equal(state.retry(), true);
  assert.equal(state.dirty, false);
  assert.equal(state.error, '');
  assert.equal(createStore(() => local).comments[0].text, '补充意见');
});

test('a stale tab cannot overwrite comments saved by another tab', () => {
  const local = storage();
  const first = createStore(() => local), stale = createStore(() => local);
  assert.equal(first.save(comment()), true);
  const saved = local.getItem(STORAGE_KEY);
  assert.equal(stale.save(comment({ id: 'second', text: '另一标签页的意见' })), false);
  assert.match(stale.error, /其他标签页/);
  assert.equal(stale.dirty, true);
  assert.equal(local.getItem(STORAGE_KEY), saved);
  assert.match(exportMarkdown(stale.comments), /另一标签页的意见/);
  assert.equal(stale.retry(), false);
  assert.equal(local.getItem(STORAGE_KEY), saved);
  const refreshed = createStore(() => local);
  assert.equal(refreshed.save(comment({ id: 'second', text: '另一标签页的意见' })), true);
  assert.equal(createStore(() => local).comments.length, 2);
  assert.equal(first.remove('one'), false);
  assert.equal(createStore(() => local).comments.length, 2);
});

test('unreadable storage is not overwritten and new comments remain exportable', () => {
  for (const raw of ['{broken', '{"version":2,"comments":[]}', '{"version":1,"comments":[{}]}']) {
    const local = storage();
    local.setItem(STORAGE_KEY, raw);
    const state = createStore(() => local);
    assert.match(state.error, /无法读取/);
    assert.equal(state.save(comment()), false);
    assert.equal(local.getItem(STORAGE_KEY), raw);
    assert.match(exportMarkdown(state.comments), /明确客户端边界/);
  }
  const blocked = createStore(() => { throw new Error('denied'); });
  assert.equal(blocked.save(comment()), false);
  assert.equal(blocked.comments.length, 1);
});

test('Markdown export groups every chapter, preserves timestamps and escapes active markup', () => {
  const text = exportMarkdown([comment({ chapterId: '09-operations', chapterTitle: '09 运维', text: '<script>alert(1)</script>\n[链接](javascript:alert(1))' }),
    comment({ id: 'two', text: '总体意见', updatedAt: '2026-10-19T10:00:00.000Z' })]);
  assert.ok(text.indexOf('00 客户端总体设计') < text.indexOf('09 运维'));
  assert.match(text, /修改时间：2026-10-19T10:00:00.000Z/);
  assert.match(text, /&lt;script&gt;/);
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('\\[链接\\]'));
});
