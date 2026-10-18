/** Shared file presentation helpers from @beui-pro/file-manager-workspace.
 * Demo entries and automatic conflict renaming are intentionally removed.
 */
export const parentPath = (path: string) =>
  path.split("/").slice(0, -1).join("/")
export const nameOf = (path: string) => path.split("/").at(-1) ?? path
export const fileSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`
export const modifiedLabel = (date: string | null) =>
  date
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(date))
    : "—"
