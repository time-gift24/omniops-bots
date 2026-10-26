"use client"

import { composerText } from "./labels"
import { Dialog, DialogContent } from "@/components/arc/dialog/dialog"
import type { AgentChatAttachment } from "./types"

export function CreditsImagePreview({
  attachment,
  src,
  onClose,
}: {
  attachment?: AgentChatAttachment
  src?: string
  onClose: () => void
}) {
  return (
    <Dialog
      open={Boolean(attachment && src)}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        title={attachment?.name ?? ""}
        closeLabel={composerText("closePreview")}
        className="w-[min(calc(100vw-2rem),64rem)]"
      >
        {attachment && src ? (
          <img
            src={src}
            alt={attachment.name}
            className="mx-auto max-h-[75vh] max-w-full object-contain"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
