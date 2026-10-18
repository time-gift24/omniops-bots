export type ModelChoice = { id: string; label: string }

export interface ModelSource {
  list(): Promise<readonly ModelChoice[]>
}
