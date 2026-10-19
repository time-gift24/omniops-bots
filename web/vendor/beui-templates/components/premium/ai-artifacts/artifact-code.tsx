"use client";

import { CodeBlock, type CodeBlockProps } from "@beui-template/components/agents/code-block";
import { cn } from "@beui-template/lib/utils";

export type ArtifactCodeProps = CodeBlockProps;

/** The public beUI agent code renderer, sized for an artifact content slot. */
export function ArtifactCode({
  className,
  maxHeight = 320,
  copyable = false,
  ...props
}: ArtifactCodeProps) {
  return (
    <CodeBlock
      className={cn("bg-transparent", className)}
      maxHeight={maxHeight}
      copyable={copyable}
      {...props}
    />
  );
}
