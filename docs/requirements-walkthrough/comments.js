/* Standalone document comments; works when index.html is opened directly. */
(function () {
  'use strict';

  const STORAGE_KEY = 'omniops-bots:requirements-walkthrough:comments:v1';

  function validComment(value) {
    return value && ['id', 'chapterId', 'chapterTitle', 'text', 'createdAt', 'updatedAt']
      .every(key => typeof value[key] === 'string' && value[key].length > 0)
      && value.text.length <= 10000 && Number.isFinite(Date.parse(value.createdAt))
      && Number.isFinite(Date.parse(value.updatedAt));
  }

  function createStore(getStorage) {
    let comments = [], error = '', dirty = false, unreadable = false, baseline = null;
    try {
      const raw = getStorage().getItem(STORAGE_KEY);
      baseline = raw;
      if (raw !== null) {
        const data = JSON.parse(raw);
        if (data.version !== 1 || !Array.isArray(data.comments) || !data.comments.every(validComment)
          || new Set(data.comments.map(comment => comment.id)).size !== data.comments.length) {
          throw new Error('Invalid saved comments');
        }
        comments = data.comments;
      }
    } catch {
      unreadable = true;
      error = '无法读取浏览器存储。为避免覆盖原记录，本页新增或修改的评论仅保留在内存中，请先导出。';
    }
    function persist() {
      dirty = true;
      if (unreadable) return false;
      try {
        const storage = getStorage();
        if (storage.getItem(STORAGE_KEY) !== baseline) {
          error = '其他标签页已更新评论，本页未覆盖它们。本次更改仅保留在内存中，请先导出全部评论，再刷新读取最新记录。';
          return false;
        }
        const serialized = JSON.stringify({ version: 1, comments });
        storage.setItem(STORAGE_KEY, serialized);
        baseline = serialized;
        dirty = false;
        error = '';
        return true;
      } catch {
        error = '保存失败：更改仅保留在本页内存中，刷新会丢失。输入仍保留，可重试保存或导出全部评论。';
        return false;
      }
    }
    return {
      get comments() { return comments; },
      get error() { return error; },
      get dirty() { return dirty; },
      save(comment) {
        if (!validComment(comment) || !comment.text.trim()) throw new Error('Invalid comment');
        comments = [...comments.filter(item => item.id !== comment.id), { ...comment }];
        return persist();
      },
      remove(id) { comments = comments.filter(comment => comment.id !== id); return persist(); },
      retry: persist,
    };
  }

  function exportMarkdown(comments) {
    const escape = value => value.replace(/[\\`*_\[\]#]/g, '\\$&')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const chapters = new Map();
    for (const comment of [...comments].sort((a, b) => a.chapterId.localeCompare(b.chapterId)
      || a.createdAt.localeCompare(b.createdAt))) {
      if (!chapters.has(comment.chapterId)) chapters.set(comment.chapterId, []);
      chapters.get(comment.chapterId).push(comment);
    }
    const lines = ['# OmniOps 客户端需求串讲 · 文档评论', '',
      '这些评论由浏览器本地记录导出，未上传服务端；可能包含尚未成功保存的内存记录。', ''];
    for (const [id, items] of chapters) {
      lines.push(`## ${escape(items[0].chapterTitle)} (${escape(id)})`, '');
      for (const item of items) {
        lines.push(`记录时间：${item.createdAt}`, '');
        if (item.updatedAt !== item.createdAt) lines.push(`修改时间：${item.updatedAt}`, '');
        lines.push(...item.text.split('\n').map(line => `> ${escape(line)}`), '');
      }
    }
    if (!comments.length) lines.push('暂无评论。', '');
    return lines.join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STORAGE_KEY, createStore, exportMarkdown };
  }
  if (typeof document === 'undefined') return;

  const store = createStore(() => window.localStorage);
  const drafts = new Map();
  let chapter, deleted;
  const make = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (text, className = 'text-control') => {
    const element = make('button', className, text);
    element.type = 'button';
    return element;
  };
  const toggle = button('本章评论', 'text-control comments-toggle');
  toggle.setAttribute('aria-controls', 'document-comments');
  toggle.setAttribute('aria-expanded', 'false');
  document.querySelector('.actions').prepend(toggle);

  const panel = make('aside', 'document-comments');
  panel.id = 'document-comments';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'comments-heading');
  const header = make('div', 'comments-header');
  const heading = make('h2', '', '文档评论');
  heading.id = 'comments-heading';
  const close = button('关闭', 'text-control');
  close.setAttribute('aria-label', '关闭文档评论');
  header.append(heading, close);
  const title = make('p', 'comments-chapter');
  const privacy = make('p', 'comments-note', '仅保存在本浏览器，尚未上传。清理浏览器数据会删除评论，请及时导出。');
  const notice = make('p', 'comments-notice');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const toolbar = make('div', 'comments-toolbar');
  const exportButton = button('导出全部评论');
  const retry = button('重试保存');
  retry.hidden = true;
  const undo = button('撤销删除');
  undo.hidden = true;
  toolbar.append(exportButton, retry, undo);
  const list = make('div', 'comments-list');
  list.setAttribute('aria-label', '本章评论列表');
  const form = make('form', 'comments-form');
  const label = make('label', '', '记录本章意见');
  label.htmlFor = 'comment-text';
  const input = make('textarea');
  input.id = 'comment-text';
  input.rows = 4;
  input.maxLength = 10000;
  input.placeholder = '讲解时的意见、疑问或待确认事项…';
  const formActions = make('div', 'comments-form-actions');
  const cancel = button('取消编辑');
  cancel.hidden = true;
  const submit = button('保存评论', 'text-control comments-submit');
  submit.type = 'submit';
  formActions.append(cancel, submit);
  form.append(label, input, formActions);
  panel.append(header, title, privacy, toolbar, notice, list, form);
  document.body.append(panel);

  function draft() {
    if (!drafts.has(chapter.id)) drafts.set(chapter.id, { text: '', recordId: null });
    return drafts.get(chapter.id);
  }
  function updateComposer() {
    const current = draft();
    input.value = current.text;
    cancel.hidden = !current.recordId;
    submit.textContent = current.recordId ? '保存修改' : '保存评论';
    submit.disabled = !current.text.trim();
    label.textContent = current.recordId ? '编辑本章意见' : '记录本章意见';
  }
  function status(message) {
    notice.textContent = store.error || message || '';
    notice.classList.toggle('comments-error', Boolean(store.error));
    retry.hidden = !store.dirty;
  }
  function render() {
    const comments = store.comments.filter(comment => comment.chapterId === chapter.id);
    toggle.textContent = comments.length ? `本章评论 · ${comments.length}` : '本章评论';
    title.textContent = chapter.title;
    list.replaceChildren();
    if (!comments.length) list.append(make('p', 'comments-empty', '本章暂无评论。'));
    for (const comment of comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const row = make('div', 'comment-entry');
      const meta = make('div', 'comment-meta');
      const time = make('time', '', new Date(comment.updatedAt).toLocaleString('zh-CN', { hour12: false }));
      time.dateTime = comment.updatedAt;
      if (comment.updatedAt !== comment.createdAt) time.append(' · 已编辑');
      const edit = button('编辑', 'comment-action');
      const remove = button('删除', 'comment-action');
      edit.setAttribute('aria-label', `编辑评论：${comment.text.slice(0, 24)}`);
      remove.setAttribute('aria-label', `删除评论：${comment.text.slice(0, 24)}`);
      edit.onclick = () => {
        const current = draft();
        if (current.text.trim() && current.recordId !== comment.id) {
          status('输入框已有未完成的意见，请先保存或清空，再编辑已有评论。');
          input.focus();
          return;
        }
        drafts.set(chapter.id, { text: comment.text, recordId: comment.id });
        updateComposer();
        input.focus();
      };
      remove.onclick = () => {
        deleted = comment;
        const saved = store.remove(comment.id);
        undo.hidden = false;
        if (draft().recordId === comment.id) drafts.set(chapter.id, { text: '', recordId: null });
        render();
        updateComposer();
        status(saved ? '评论已删除，可撤销本次删除。' : '');
      };
      meta.append(time, edit, remove);
      row.append(meta, make('p', 'comment-text', comment.text));
      list.append(row);
    }
  }
  function syncChapter() {
    const article = document.querySelector('article:not([hidden])');
    if (!article || chapter?.id === article.id) return;
    chapter = { id: article.id, title: article.querySelector('h1').textContent };
    render();
    updateComposer();
    status('');
  }
  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) input.focus(); else toggle.focus();
  }
  toggle.onclick = () => setOpen(panel.hidden);
  close.onclick = () => setOpen(false);
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
  });
  input.addEventListener('input', () => {
    draft().text = input.value;
    submit.disabled = !input.value.trim();
  });
  form.onsubmit = event => {
    event.preventDefault();
    const current = draft(), text = input.value.trim();
    if (!text) return;
    const old = store.comments.find(comment => comment.id === current.recordId);
    const now = new Date().toISOString();
    const id = old?.id || window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const saved = store.save({ id, chapterId: chapter.id, chapterTitle: chapter.title,
      text, createdAt: old?.createdAt || now, updatedAt: now });
    drafts.set(chapter.id, saved ? { text: '', recordId: null } : { text: input.value, recordId: id });
    render();
    updateComposer();
    status(saved ? '评论已保存到本浏览器，尚未上传。' : '');
    input.focus();
  };
  cancel.onclick = () => { drafts.set(chapter.id, { text: '', recordId: null }); updateComposer(); input.focus(); };
  undo.onclick = () => {
    if (!deleted) return;
    const saved = store.save(deleted);
    deleted = null;
    undo.hidden = true;
    render();
    status(saved ? '已恢复删除的评论。' : '');
  };
  retry.onclick = () => status(store.retry() ? '全部更改已保存到本浏览器，尚未上传。' : '');
  exportButton.onclick = () => {
    const blob = new Blob([exportMarkdown(store.comments)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = make('a');
    link.href = url;
    link.download = `omniops-bots-document-comments-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('已导出全部已记录评论；输入框中尚未保存的草稿不在导出文件中。');
  };
  window.addEventListener('beforeunload', event => {
    if (store.dirty || [...drafts.values()].some(value => value.text.trim())) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  window.addEventListener('walkthrough:chapterchange', syncChapter);
  syncChapter();
}());
