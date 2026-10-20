"use client";

import type { ComponentProps } from "react";
import { CreditsToolbar as BeuiCreditsToolbar } from "@/components/beui/premium/agent-chat-input/credits-toolbar";
import { AGENT_COMPOSER_PRESENTATION } from "./presentation";

export function CreditsToolbar(props: Omit<ComponentProps<typeof BeuiCreditsToolbar>, "presentation">) {
  return <BeuiCreditsToolbar {...props} presentation={AGENT_COMPOSER_PRESENTATION} />;
}
