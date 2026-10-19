"use client";

import { motion } from "motion/react";
import { Button } from "@beui-template/components/motion/button";
import { SPRING_LAYOUT } from "@beui-template/lib/ease";
import { cn } from "@beui-template/lib/utils";
import type { WhatsNewLabels, WhatsNewSlide } from "./whats-new-data";

export type WhatsNewStepDotsProps = {
  slides: WhatsNewSlide[];
  index: number;
  labels: WhatsNewLabels;
  reduceMotion: boolean;
  onSelect: (index: number) => void;
};

/** Step indicator; the active dot stretches into a pill. */
export function WhatsNewStepDots({
  slides,
  index,
  labels,
  reduceMotion,
  onSelect,
}: WhatsNewStepDotsProps) {
  return (
    <div className="flex items-center">
      {slides.map((slide, position) => {
        const active = position === index;
        return (
          <Button
            key={slide.id}
            variant="plain"
            size="sm"
            aria-label={labels.goToSlide(position + 1, slide.title)}
            aria-current={active ? "step" : undefined}
            onClick={() => onSelect(position)}
            whileHover={undefined}
            whileTap={undefined}
            className="group flex h-10 items-center justify-center px-1"
          >
            <motion.span
              layout={!reduceMotion}
              transition={SPRING_LAYOUT}
              style={{ borderRadius: 999 }}
              className={cn(
                "block h-2 transition-colors",
                active
                  ? "w-6 bg-foreground"
                  : "w-2 bg-foreground/20 group-hover:bg-foreground/40",
              )}
            />
          </Button>
        );
      })}
    </div>
  );
}
