import { invalid, RuntimeError } from './errors.mjs';

const MAX_FILE = 8 * 1024 * 1024;
const IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT = new Set(['application/json', 'application/xml', 'application/javascript']);

export function identifier(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw invalid(`${name} 无效。`);
  return value;
}

export function httpUrl(value, { normalize = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) throw invalid('请输入有效的网址。');
  let url;
  try { url = new URL(normalize && !/^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? `https://${value.trim()}` : value); }
  catch { throw invalid('请输入有效的网址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('仅支持不含登录信息的 HTTP 或 HTTPS 网址。');
  return url.href;
}

function text(value, name, max = 64_000) {
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} 格式无效或过长。`);
  return value;
}

function attachmentContent(file, budget) {
  if (!file || typeof file !== 'object') throw invalid('附件格式无效。');
  const name = text(file.name, '附件名称', 256);
  const mediaType = text(file.mediaType, '附件类型', 128).toLowerCase().split(';')[0].trim();
  const image = IMAGES.has(mediaType);
  if (!image && !mediaType.startsWith('text/') && !TEXT.has(mediaType)) throw new RuntimeError('unsupported', `暂不支持 ${mediaType || '此类型'} 附件，请使用文本或 PNG/JPEG/GIF/WebP 图片。`);
  if (file.data !== undefined && file.url !== undefined) throw invalid('附件只能提供一种内容来源。');
  let encoded = file.data;
  if (file.url !== undefined) {
    if (typeof file.url !== 'string') throw invalid('附件地址无效。');
    if (file.url.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.url);
      if (!match || match[1].toLowerCase() !== mediaType) throw invalid('附件 data URL 格式或类型无效。');
      encoded = match[2];
    } else {
      const url = httpUrl(file.url);
      if (!image) throw new RuntimeError('unsupported', '远程文本附件请先下载并作为文件添加。');
      return [{ type: 'text', text: `图片附件：${name}` }, { type: 'image_url', image_url: { url } }];
    }
  }
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_FILE / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalid('附件内容无效或超过 8 MiB。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_FILE || bytes.toString('base64') !== encoded) throw invalid('附件内容无效或超过 8 MiB。');
  budget.bytes += bytes.length;
  if (budget.bytes > 24 * 1024 * 1024) throw invalid('本轮附件合计不能超过 24 MiB。');
  if (image) return [{ type: 'text', text: `图片附件：${name}` }, { type: 'image_url', image_url: { url: `data:${mediaType};base64,${encoded}` } }];
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalid('文本附件必须使用 UTF-8 编码。'); }
  return [{ type: 'text', text: `附件 ${name}：\n${content}` }];
}

export function chatInput(request, configuredModel, { managedModels = false } = {}) {
  if (!request || typeof request !== 'object' || !Array.isArray(request.messages) || !request.messages.length || request.messages.length > 20) throw invalid('消息格式无效。');
  const model = request.model === undefined ? configuredModel : identifier(request.model, 'model');
  if (!managedModels && !configuredModel) throw new RuntimeError('unavailable', '请在设置中配置 Provider 和模型。');
  if (!managedModels && model !== configuredModel) throw new RuntimeError('unsupported', '所选模型未配置，请选择当前可用模型。');
  const instructions = request.instructions === undefined ? '' : text(request.instructions, 'Agent 指令', 256 * 1024);
  const history = request.history ?? [];
  if (!Array.isArray(history) || history.length > 1000) throw invalid('对话上下文过长。');
  const messages = history.map(item => {
    if (!item || !['user', 'assistant'].includes(item.role)) throw invalid('对话上下文格式无效。');
    return { role: item.role, content: text(item.text, '历史消息') };
  });
  if (messages.reduce((size, item) => size + item.content.length, 0) > 1_000_000) throw invalid('对话上下文过长。');
  const budget = { bytes: 0 };
  for (const message of request.messages) {
    if (message?.role !== 'user') throw invalid('本轮只能提交用户消息。');
    const content = text(message.text, '消息');
    const files = message.attachments ?? [];
    if (!Array.isArray(files) || files.length > 20) throw invalid('附件数量过多。');
    if (!content.trim() && !files.length) throw invalid('请输入消息或添加附件。');
    messages.push({ role: 'user', content: files.length ? [{ type: 'text', text: content }, ...files.flatMap(file => attachmentContent(file, budget))] : content });
  }
  return { model, instructions, messages, title: request.messages.map(message => message.text).join(' ').trim().slice(0, 60) || '附件任务' };
}
