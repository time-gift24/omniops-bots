import { createHash } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { invalid } from './errors.ts';
import { identifier } from './input.ts';

export type FingerprintInput = {
  agent: { id: string; contentId: string };
  skills: readonly { id: string; contentId: string; mountPath: string }[];
  provider: { protocol: string; baseURL: string };
  modelId: string;
  parameters: Record<string, unknown>;
  modelRevision?: string | null;
};
const digest = (value: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw invalid('指纹内容摘要无效。'); return value; };
/** Hash only the actual non-secret model request settings and immutable asset composition.
 * createRunFingerprint({agent:session.agent,skills:session.skills,provider,modelId:provider.model,parameters});
 * Returns its complete explainable composition; it neither performs I/O nor alters a Run.
 */
export function createRunFingerprint(input: FingerprintInput) {
  if (!input || !Array.isArray(input.skills) || input.skills.length > 256 || !input.provider || !input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) throw invalid('运行指纹输入无效。');
  let address: URL;
  try { address = new URL(input.provider.baseURL); } catch { throw invalid('指纹 Provider 地址无效。'); }
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.hash || address.search) throw invalid('指纹 Provider 地址无效。');
  const allowed = new Set(['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'parallel_tool_calls', 'seed', 'reasoning_effort', 'thinking']);
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.parameters)) {
    if (!allowed.has(key)) throw invalid('指纹不允许保存该模型参数。');
    if (key === 'thinking') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !['disabled', 'enabled'].includes((value as {type:string}).type)) throw invalid('指纹思考参数无效。');
      parameters[key] = {type:(value as {type:string}).type};
    } else {
      if (!['number','string','boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || typeof value === 'string' && (value.length > 128 || /[\x00-\x1f\x7f]/u.test(value))) throw invalid('指纹模型参数无效。');
      parameters[key] = value;
    }
  }
  const skills = input.skills.map(skill => {
    const contentId = digest(skill.contentId), source = /^official\/([^/]+)\/([a-f0-9]{64})$/u.exec(skill.id);
    if (source && source[2] !== contentId) throw invalid('指纹 Skill 身份不匹配。');
    if (!/^\/skills\/(?:[A-Za-z0-9_-]+\/)+$/u.test(skill.mountPath)) throw invalid('指纹 Skill 挂载无效。');
    return {skillId:identifier(source?.[1] ?? skill.id,'Skill'),contentId,mountPath:skill.mountPath};
  }).sort((a,b) => { const left=[a.skillId,a.contentId,a.mountPath],right=[b.skillId,b.contentId,b.mountPath]; for(let i=0;i<3;i++){if(left[i]!<right[i]!)return -1;if(left[i]!>right[i]!)return 1;} return 0; });
  if (new Set(skills.map(skill=>skill.skillId)).size !== skills.length) throw invalid('指纹 Skill 身份重复。');
  const composition = {
    fingerprintVersion:1 as const,
    agent:{agentId:identifier(input.agent.id,'Agent'),contentId:digest(input.agent.contentId)},
    skills,
    provider:{protocol:identifier(input.provider.protocol,'Provider 协议'),baseUrl:address.href},
    modelId:identifier(input.modelId,'模型'),
    modelRevision:input.modelRevision == null ? null : identifier(input.modelRevision,'模型修订'),
    parameters,
  };
  return {fingerprintVersion:1 as const,fingerprint:createHash('sha256').update(canonicalize(composition)).digest('hex'),composition};
}
