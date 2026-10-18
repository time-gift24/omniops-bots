/**
 * 工作台的数据与宿主能力边界。
 *
 * UI（components/workbench）只依赖这个接口，不直接读取文件系统、
 * 会话状态或调用平台能力；具体实现由桌面端／服务端接入时提供，
 * 当前由 mock-backend 提供示例实现。
 */

/** 新标签页推荐位的站点。 */
export type RecommendedSite = { name: string; url: string; initial: string };

/** 工作区文件列表项。 */
export type WorkspaceFileEntry = { name: string; path: string; size: string };

/** 文件预览内容，按行返回。 */
export type FilePreview = { path: string; lines: readonly string[] };

/** 单个文件的变更统计。 */
export type ChangedFile = { path: string; added: number; removed: number };

/** 当前会话的变更摘要。 */
export type ChangeSet = {
  fileCount: number;
  added: number;
  removed: number;
  files: readonly ChangedFile[];
};

export interface WorkbenchBackend {
  /** 新标签页的推荐站点。 */
  listRecommendations(): Promise<readonly RecommendedSite[]>;
  /** 当前工作区的文件列表。 */
  listWorkspaceFiles(): Promise<readonly WorkspaceFileEntry[]>;
  /** 读取文件预览内容。 */
  readFilePreview(path: string): Promise<FilePreview>;
  /** 当前会话的变更摘要。 */
  getChangeSet(): Promise<ChangeSet>;
  /** 在系统默认浏览器中打开链接。 */
  openExternal(url: string): void;
}
