import type { Skill } from "@/skills/source"
import type { AgentConfiguration, AgentResources } from "@/agents/source"
import { array, boolean, number, object, string } from "./protocol"

export function readAgentConfiguration(value: unknown): AgentConfiguration {
  const raw = object(value)
  return {
    name: string(raw.name),
    description: string(raw.description),
    instructions: string(raw.instructions),
    requireApproval: boolean(raw.requireApproval),
    mcpServerIds: array(raw.mcpServerIds, string),
    toolIds: array(raw.toolIds, string),
    skillIds: array(raw.skillIds, string),
  }
}
const resource = (value: unknown) => {
  const raw = object(value)
  return {
    id: string(raw.id),
    name: string(raw.name),
    description: string(raw.description),
  }
}
const capability = (value: unknown) => {
  const raw = object(value)
  return {
    name: string(raw.name),
    description: string(raw.description),
    ...(raw.params === undefined ? {} : { params: string(raw.params) }),
  }
}
export function readAgents(value: unknown) {
  const raw = object(value),
    resources = object(raw.resources)
  const parsedResources: AgentResources = {
    tools: array(resources.tools, resource),
    skills: array(resources.skills, resource),
    mcpServers: array(resources.mcpServers, (value) => {
      const raw = object(value),
        capabilities = object(raw.capabilities)
      return {
        ...resource(raw),
        capabilities: {
          tools: array(capabilities.tools, capability),
          resources: array(capabilities.resources, capability),
          prompts: array(capabilities.prompts, capability),
        },
      }
    }),
  }
  return {
    agents: array(raw.agents, (value) => {
      const entry = object(value)
      return {
        id: string(entry.id),
        configuration: readAgentConfiguration(entry.configuration),
      }
    }),
    resources: parsedResources,
  }
}
export function readDirectory(value: unknown) {
  const raw = object(value)
  return { path: string(raw.path), name: string(raw.name) }
}
export function readFiles(value: unknown) {
  return array(value, (entry) => {
    const raw = object(entry)
    return {
      path: string(raw.path),
      name: string(raw.name),
      size: string(raw.size),
    }
  })
}
export function readFile(value: unknown) {
  const raw = object(value)
  return { path: string(raw.path), lines: array(raw.lines, string) }
}
export function readChanges(value: unknown) {
  const raw = object(value)
  return {
    fileCount: number(raw.fileCount),
    added: number(raw.added),
    removed: number(raw.removed),
    files: array(raw.files, (value) => {
      const file = object(value)
      return {
        path: string(file.path),
        added: number(file.added),
        removed: number(file.removed),
      }
    }),
  }
}
export function readSkills(value: unknown): Skill[] {
  return array(value, (entry): Skill => {
    const raw = object(entry)
    return {
      id: string(raw.id),
      name: string(raw.name),
      description: string(raw.description),
      ...(raw.origin === "official" || raw.origin === "local" ? { origin: raw.origin } : {}),
      ...(raw.version === undefined ? {} : { version: string(raw.version) }),
      files: array(raw.files, (entry) => {
        const file = object(entry)
        return { path: string(file.path), content: string(file.content) }
      }),
    }
  })
}
