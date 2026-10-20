"use client";

import type { ComponentProps } from "react";
import { CreditsAttachmentTray as BeuiCreditsAttachmentTray } from "@/components/beui/premium/agent-chat-input/credits-attachment-tray";
import { AGENT_COMPOSER_PRESENTATION } from "./presentation";

export function CreditsAttachmentTray(props: Omit<ComponentProps<typeof BeuiCreditsAttachmentTray>, "presentation">) {
  return <BeuiCreditsAttachmentTray {...props} presentation={AGENT_COMPOSER_PRESENTATION} />;
}
