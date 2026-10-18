import { HugeiconsIcon } from "@hugeicons/react";
import { FileTextIcon } from "@hugeicons-pro/core-stroke-rounded";
import type { WorkbenchBackend, WorkspaceFileEntry } from "@/workbench/backend";
import {
  useBackendData,
  type BackendDataState,
} from "./use-backend-data";

function FileList({
  files,
  onOpenFile,
}: {
  files: BackendDataState<readonly WorkspaceFileEntry[]>;
  onOpenFile: (path: string) => void;
}) {
  if (files.status === "loading") {
    return (
      <ul className="space-y-0.5" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <li
            key={index}
            className="h-[54px] animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
          />
        ))}
      </ul>
    );
  }
  if (files.status === "error") {
    return (
      <p className="px-2.5 py-2 text-xs text-muted-foreground">
        文件列表加载失败。
      </p>
    );
  }
  if (files.data.length === 0) {
    return (
      <p className="px-2.5 py-2 text-xs text-muted-foreground">
        工作区目录为空。
      </p>
    );
  }
  return (
    <ul className="space-y-0.5">
      {files.data.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => onOpenFile(file.path)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HugeiconsIcon
              icon={FileTextIcon}
              size={16}
              strokeWidth={1.7}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{file.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted-foreground">
                {file.path}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
              {file.size}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FilesView({
  backend,
  onOpenFile,
}: {
  backend: WorkbenchBackend;
  onOpenFile: (path: string) => void;
}) {
  const files = useBackendData("workspace-files", () =>
    backend.listWorkspaceFiles(),
  );
  return (
    <div className="h-full overflow-auto p-2">
      <FileList files={files} onOpenFile={onOpenFile} />
    </div>
  );
}

export function FileView({
  backend,
  path,
}: {
  backend: WorkbenchBackend;
  path: string;
}) {
  const preview = useBackendData(path, () => backend.readFilePreview(path));
  return (
    <div className="h-full overflow-auto p-3">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <p className="truncate border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {path}
        </p>
        {preview.status === "loading" ? (
          <div className="space-y-2.5 p-3" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <div
                key={index}
                className="h-4 animate-pulse rounded bg-muted motion-reduce:animate-none"
                style={{ width: `${88 - ((index * 13) % 55)}%` }}
              />
            ))}
          </div>
        ) : preview.status === "error" ? (
          <p className="p-3 text-xs text-muted-foreground">文件加载失败。</p>
        ) : (
          <ol className="overflow-x-auto p-3 font-mono text-xs leading-6">
            {preview.data.lines.map((line, index) => (
              <li key={index} className="flex gap-4 whitespace-pre">
                <span
                  aria-hidden="true"
                  className="w-6 shrink-0 text-right text-muted-foreground/50 select-none tabular-nums"
                >
                  {index + 1}
                </span>
                <span className="min-w-0">{line || " "}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
