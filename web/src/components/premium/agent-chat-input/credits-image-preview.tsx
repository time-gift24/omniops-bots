"use client";

import type { ComponentProps } from "react";
import { CreditsImagePreview as BeuiCreditsImagePreview } from "@/components/beui/premium/agent-chat-input/credits-image-preview";
import { AGENT_COMPOSER_PRESENTATION } from "./presentation";

export function CreditsImagePreview(props: Omit<ComponentProps<typeof BeuiCreditsImagePreview>, "presentation">) {
  return <BeuiCreditsImagePreview {...props} presentation={AGENT_COMPOSER_PRESENTATION} />;
}
