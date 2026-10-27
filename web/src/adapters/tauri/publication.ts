import type {
  Publication,
  PublicationPreview,
  ResourcePublicationSource,
} from "@/resources/publication"
import { array, choice, number, object, string } from "./protocol"
import { readAgent } from "./resources"
import { readSkill } from "./skills"

const kind = (value: unknown) => choice(value, ["agent", "skill"] as const)
const contentId = (value: unknown) => {
  const text = string(value)
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("资源内容摘要无效。")
  return text
}
const limited = <T>(value: unknown, read: (item: unknown) => T) => {
  const result = array(value, read)
  if (result.length > 1000) throw new Error("资源列表超过限制。")
  return result
}
export function readPublication(value: unknown): Publication {
  const raw = object(value)
  const result: Publication = {
    operationId: string(raw.operationId),
    kind: kind(raw.kind),
    localId: string(raw.localId),
    officialId: raw.officialId === null ? null : string(raw.officialId),
    contentId: contentId(raw.contentId),
    phase: choice(raw.phase, ["prepared", "uploaded", "published"] as const),
    files: limited(raw.files, (item) => {
      const file = object(item)
      return {
        path: string(file.path),
        kind: choice(file.kind, ["file", "folder"] as const),
        ...(file.bytes === undefined ? {} : { bytes: number(file.bytes) }),
        ...(file.sha256 === undefined
          ? {}
          : { sha256: contentId(file.sha256) }),
      }
    }),
    ...(raw.draftRevisionId === undefined
      ? {}
      : { draftRevisionId: string(raw.draftRevisionId) }),
    ...(raw.revision === undefined ? {} : { revision: string(raw.revision) }),
    ...(raw.preview === undefined
      ? {}
      : { preview: readPublicationPreview(raw.preview) }),
    ...(raw.publication === undefined
      ? {}
      : {
          publication: (() => {
            const publication = object(raw.publication)
            return {
              releaseTag: string(publication.releaseTag),
              affectedAgents: limited(publication.affectedAgents, (item) => {
                const agent = object(item)
                return {
                  agentId: string(agent.agentId),
                  expectedContentId: contentId(agent.expectedContentId),
                  releaseTag: string(agent.releaseTag),
                }
              }),
            }
          })(),
        }),
    ...(raw.release === undefined
      ? {}
      : {
          release: (() => {
            const release = object(raw.release)
            return {
              releaseId: string(release.releaseId),
              versions: limited(release.versions, (item) => {
                const version = object(item)
                return {
                  kind: kind(version.kind),
                  id: string(version.id),
                  contentId: contentId(version.contentId),
                  releaseTag: string(version.releaseTag),
                }
              }),
            }
          })(),
        }),
  }
  if (
    result.preview &&
    (result.preview.kind !== result.kind ||
      result.preview.contentId !== result.contentId)
  )
    throw new Error("发布预览与冻结内容不一致。")
  if (result.phase === "uploaded" && !result.draftRevisionId)
    throw new Error("上传回执缺少草稿修订。")
  if (
    result.phase === "published" &&
    (!result.release ||
      !result.release.versions.some(
        (version) =>
          version.kind === result.kind &&
          version.id === result.officialId &&
          version.contentId === result.contentId
      ))
  )
    throw new Error("发布回执与冻结内容不一致。")
  return result
}
export function readPublicationPreview(value: unknown): PublicationPreview {
  const raw = object(value)
  return {
    kind: kind(raw.kind),
    contentId: contentId(raw.contentId),
    expectedContentId:
      raw.expectedContentId === null ? null : contentId(raw.expectedContentId),
    ...(raw.baseline === undefined ? {} : { baseline: string(raw.baseline) }),
    affectedAgents: limited(raw.affectedAgents, (item) => {
      const agent = object(item)
      return {
        agentId: string(agent.agentId),
        expectedContentId: contentId(agent.expectedContentId),
      }
    }),
  }
}
export function createTauriPublications(
  request: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<unknown>
): ResourcePublicationSource {
  return {
    prepare: async (input) =>
      readPublication(await request("resource_prepare", input)),
    listOperations: async (input = {}) => {
      const raw = object(
        await request("resource_publication_operations", input)
      )
      return { items: limited(raw.items, readPublication) }
    },
    uploadDraft: async (operationId) =>
      readPublication(await request("resource_upload_draft", { operationId })),
    preview: async (operationId) =>
      readPublicationPreview(
        await request("resource_publish_preview", { operationId })
      ),
    publish: async (input) =>
      readPublication(
        await request("resource_publish", {
          ...input,
          ...(input.affectedAgents
            ? { affectedAgents: [...input.affectedAgents] }
            : {}),
        })
      ),
    versions: async (input) => {
      const raw = object(await request("resource_versions", input))
      return {
        items: limited(raw.items, (item) => {
          const version = object(item)
          return {
            contentId: contentId(version.contentId),
            ...(version.releaseTag === undefined
              ? {}
              : { releaseTag: string(version.releaseTag) }),
            ...(version.publishedAt === undefined
              ? {}
              : { publishedAt: string(version.publishedAt) }),
          }
        }),
        nextCursor: raw.nextCursor === null ? null : string(raw.nextCursor),
      }
    },
    selectHistory: async (input) => {
      const raw = object(await request("resource_select_history", input))
      return {
        kind: kind(raw.kind),
        officialId: string(raw.officialId),
        contentId: contentId(raw.contentId),
        ...(raw.localId === undefined ? {} : { localId: string(raw.localId) }),
        ...(raw.agent === undefined ? {} : { agent: readAgent(raw.agent) }),
        ...(raw.skill === undefined ? {} : { skill: readSkill(raw.skill) }),
      }
    },
  }
}
