"use client";

import type { ComponentProps } from "react";
import { CreditsSearchToggle as BeuiCreditsSearchToggle } from "@/components/beui/premium/agent-chat-input/credits-search-toggle";
import { AGENT_COMPOSER_PRESENTATION } from "./presentation";

export function CreditsSearchToggle(props: Omit<ComponentProps<typeof BeuiCreditsSearchToggle>, "presentation">) {
  return <BeuiCreditsSearchToggle {...props} presentation={AGENT_COMPOSER_PRESENTATION} />;
}
