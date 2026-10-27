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
  diagnosticsOnly?: boolean
  /** Safe platform projection; absent on older/demo adapters means unconfigured. */
  connection?: DesktopConnection
  update?: DesktopUpdate
  closeBlocked?: boolean
  simulated: boolean
  /** Active runs across all threads. Older demo adapters expose only task. */
  tasks?: DesktopTask[]
  /** Thread owning the selected Chrome page; null selects the manual browser page. */
  browserThreadId?: string | null
  /** Active task on the selected browser page. */
  task: DesktopTask | null
  browser: BrowserSnapshot
  /** Manual operations page, independent of Agent Chrome and its active thread. */
  operationsBrowser?: BrowserSnapshot
  /** Increments once for each new browser call, including before approval. */
  browserRequest: number
}

export interface DesktopConnection {
  state:
    | "offline"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "blocked"
    | "closing"
    | "closed"
  reason?: string
  permissions: readonly string[]
  destination?: string
  account?: string
}
export interface DiagnosticThread {
  threadId: string
  title: string
  lastUpdated: string
  checkpointAvailable: boolean
}
export interface DiagnosticPackage {
  uploadId: string
  threadId: string
  packageFile: string
  bundleSha256: string
  manifest: Readonly<Record<string, unknown>>
  preview: {
    files: readonly { path: string; bytes: number }[]
    missing: readonly { item: string; reason: string }[]
    attachments: readonly { id: string; name: string }[]
    redactionPolicy: string
  }
}
export type SavedDiagnosticPackage = Pick<
  DiagnosticPackage,
  "uploadId" | "threadId" | "bundleSha256" | "preview"
> & { createdAt: string }
export type DiagnosticFilePreview =
  | { mediaType: "text/plain"; text: string; truncated: boolean }
  | {
      mediaType: "image/png" | "image/jpeg"
      dataUrl: string
      truncated: boolean
    }
export interface DiagnosticUploadState {
  state: "pending" | "received" | "failed"
  uploadId: string
  diagnosticId?: string
  threadId?: string
  bundleSha256?: string
  receivedAt?: string
  incomplete?: boolean
  missing?: readonly string[]
}
export interface DesktopUpdate {
  phase:
    | "disabled"
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "failed"
  currentVersion: string
  version?: string
  notes?: string
  downloadedBytes: number
  totalBytes?: number
  error?: string
}

/** Legacy demo adapters retain their single shared task slot. */
export function threadTask(
  snapshot: DesktopSnapshot,
  threadId: string
): DesktopTask | null {
  return snapshot.tasks === undefined
    ? snapshot.task
    : (snapshot.tasks.find((task) => task.threadId === threadId) ?? null)
}

export interface ApprovalDecision {
  runId: string
  approvalId: string
  decision: "approve" | "reject"
  reason?: string
}

export interface DesktopSettings {
  maxConcurrentRuns: number
}

/** Logical CSS pixels of the manual operations surface in the application window. */
export interface BrowserViewport {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopRuntime {
  /** Connection changes do not stop tasks; rejection leaves existing data intact. */
  reconnectPlatform?(): Promise<void>
  /** Read-only thread listing and frozen diagnostic preparation. Pages never pass local paths.
   * Navigating away ignores late UI results but does not cancel runs or delete prepared packages.
   * Upload needs explicit consent after preview; retry/query retains the same immutable uploadId.
   */
  listDiagnosticThreads?(options?: {
    cursor?: string
    limit?: number
  }): Promise<{ items: readonly DiagnosticThread[]; nextCursor: string | null }>
  exportDiagnostics?(
    threadId: string,
    includeAttachments?: readonly string[]
  ): Promise<DiagnosticPackage>
  /** Retained immutable ZIPs may be reopened after navigation/restart. Preview paths
   * must come from the selected package manifest; no arbitrary filesystem access. */
  listDiagnosticPackages?(): Promise<readonly SavedDiagnosticPackage[]>
  openDiagnosticPackage?(uploadId: string): Promise<DiagnosticPackage>
  previewDiagnosticFile?(
    uploadId: string,
    path: string
  ): Promise<DiagnosticFilePreview>
  uploadDiagnostics?(
    uploadId: string,
    consent: true
  ): Promise<DiagnosticUploadState>
  diagnosticUploadStatus?(uploadId: string): Promise<DiagnosticUploadState>
  /** Native signed updater. Reading never downloads or installs; both actions are explicit. */
  readUpdate?(): Promise<DesktopUpdate>
  checkUpdate?(): Promise<DesktopUpdate>
  downloadUpdate?(): Promise<DesktopUpdate>
  /** The host owns the final install/restart confirmation and maintenance gate.
   * Cancellation resolves with the retained ready state; preparation failure rejects.
   */
  installUpdate?(): Promise<DesktopUpdate>
  /** Positions the manual operations page; null hides it without closing it. */
  setBrowserViewport?(bounds: BrowserViewport | null): Promise<void>
  readOperationsBrowser?(): Promise<BrowserSnapshot>
  /** Manual operations never acquire or navigate an Agent's Chrome page. */
  operationsNavigate?(url: string): Promise<void>
  operationsBack?(): Promise<void>
  operationsForward?(): Promise<void>
  operationsReload?(): Promise<void>
  /** Reads this client's effective settings, including initial defaults. */
  readSettings?(): Promise<DesktopSettings>
  /** Persists an integer limit (1–64) before applying it to new admissions.
   * Existing runs continue. Failures leave the effective limit unchanged.
   * Calls are scoped to this client. Demo saves are memory-only.
   */
  saveSettings?(settings: DesktopSettings): Promise<DesktopSettings>
  /** Selects a thread's snapshot; focus creates or reveals its external Chrome page. */
  selectBrowserThread?(
    threadId: string | null,
    options?: { focus?: boolean }
  ): Promise<void>
  /** Stable immutable snapshot; scoped to this adapter instance. */
  getState(): DesktopSnapshot
  /** Subscription cleanup does not stop a task or destroy the page. */
  subscribe(listener: () => void): () => void
  /** Resolves after acceptance, not task completion. Stale decisions reject. */
  decide(decision: ApprovalDecision): Promise<void>
  /** Resolves only when this run is stopped and its task slot is released. */
  stop(runId: string): Promise<void>
  /** Manual navigation rejects while a task or navigation owns the selected page. */
  navigate(url: string): Promise<void>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
}
