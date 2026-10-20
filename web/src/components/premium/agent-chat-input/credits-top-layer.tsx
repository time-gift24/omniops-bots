"use client";

import type { ComponentProps } from "react";
import { CreditsTopLayer as BeuiCreditsTopLayer } from "@/components/beui/premium/agent-chat-input/credits-top-layer";
import { AGENT_COMPOSER_PRESENTATION } from "./presentation";

export function CreditsTopLayer(props: Omit<ComponentProps<typeof BeuiCreditsTopLayer>, "presentation">) {
  return <BeuiCreditsTopLayer {...props} presentation={AGENT_COMPOSER_PRESENTATION} />;
}
