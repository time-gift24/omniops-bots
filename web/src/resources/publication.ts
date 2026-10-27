import type { AgentEntry } from "@/agents/source"
import type { ManagedSkill } from "@/skills/library"
export type ResourceKind = "agent" | "skill"
export type HistoricalResource = {
  kind: ResourceKind
  officialId: string
  contentId: string
  localId?: string
  agent?: AgentEntry
  skill?: ManagedSkill
}
export type Publication = {
  operationId: string
  kind: ResourceKind
  localId: string
  officialId: string | null
  contentId: string
  phase: "prepared" | "uploaded" | "published"
  files: readonly {
    path: string
    kind: "file" | "folder"
    bytes?: number
    sha256?: string
  }[]
  draftRevisionId?: string
  revision?: string
  preview?: PublicationPreview
  publication?: {
    releaseTag: string
    affectedAgents: readonly {
      agentId: string
      expectedContentId: string
      releaseTag: string
    }[]
  }
  release?: {
    releaseId: string
    versions: readonly {
      kind: ResourceKind
      id: string
      contentId: string
      releaseTag: string
    }[]
  }
}
export type PublicationPreview = {
  kind: ResourceKind
  contentId: string
  baseline?: string
  expectedContentId: string | null
  affectedAgents: readonly { agentId: string; expectedContentId: string }[]
}
export type ResourceVersion = {
  contentId: string
  releaseTag?: string
  publishedAt?: string
}

/** Operations-only platform boundary. Preparation freezes the saved local package,
 * not unsaved editor text. Network failures retain operationId, frozen bytes and
 * idempotency keys; retry the same operation/body until its outcome is known.
 * New edits require a new preparation. Versions are immutable and history copies
 * receive independent local IDs. No background requests or subscriptions. All
 * failures reject with safe messages; leaving the page never cancels a Run.
 */
export interface ResourcePublicationSource {
  prepare(input: {
    kind: ResourceKind
    id: string
    officialId?: string
    createOfficial?: boolean
    expectedRevision?: string | null
  }): Promise<Publication>
  listOperations(input?: {
    kind?: ResourceKind
    localId?: string
  }): Promise<{ items: readonly Publication[] }>
  uploadDraft(operationId: string): Promise<Publication>
  preview(operationId: string): Promise<PublicationPreview>
  publish(input: {
    operationId: string
    releaseTag: string
    affectedAgents?: readonly {
      agentId: string
      expectedContentId: string
      releaseTag: string
    }[]
  }): Promise<Publication>
  versions(input: {
    kind: ResourceKind
    id: string
    cursor?: string
    limit?: number
  }): Promise<{ items: readonly ResourceVersion[]; nextCursor: string | null }>
  selectHistory(input: {
    kind: ResourceKind
    id: string
    contentId: string
    editable?: boolean
  }): Promise<HistoricalResource>
}
