/** App-scoped desktop capabilities. Shared UI never imports a platform SDK. */
export interface BrowserSnapshot {
  url: string
  title: string
  status: "empty" | "loading" | "ready" | "error"
  canGoBack: boolean
  canGoForward: boolean
  error?: string
  /** Explicitly simulated content; never treated as a live embedded webpage. */
  preview?: {
    heading: string
    text: string
    field?: { label: string; value: string }
  }
}

export interface ApprovalRequest {
  id: string
  callId: string
  title: string
  description: string
  targetUrl?: string
  toolName: string
  parameters: string
  code?: string
}

export interface DesktopTask {
  runId: string
  threadId: string
  title: string
  phase:
    "preparing" | "running" | "awaiting-approval" | "submitting" | "stopping"
  approval?: ApprovalRequest
  error?: string
}

export interface DesktopSnapshot {
  closeBlocked?: boolean
  simulated: boolean
  task: DesktopTask | null
  browser: BrowserSnapshot
  /** Increments once for each new browser call, including before approval. */
  browserRequest: number
}

export interface ApprovalDecision {
  runId: string
  approvalId: string
  decision: "approve" | "reject"
  reason?: string
}

/** Logical CSS pixels relative to the application window content. */
export interface BrowserViewport {
  x: number
  y: number
  width: number
  height: number
  /** Tasks retain exclusive browser input while the live page remains visible. */
  interactive: boolean
}

export interface DesktopRuntime {
  /** Null hides the native surface without navigating or stopping a task. */
  setBrowserViewport(bounds: BrowserViewport | null): Promise<void>
  /** Stable immutable snapshot; scoped to this adapter instance. */
  getState(): DesktopSnapshot
  /** Subscription cleanup does not stop a task or destroy the page. */
  subscribe(listener: () => void): () => void
  /** Resolves after acceptance, not task completion. Stale decisions reject. */
  decide(decision: ApprovalDecision): Promise<void>
  /** Resolves only when this run is stopped and its task slot is released. */
  stop(runId: string): Promise<void>
  /** Manual navigation rejects while a task or another navigation owns the browser. */
  navigate(url: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
}
