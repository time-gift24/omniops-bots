"use client"

import { composerText } from "./labels"
import { Box, Check, X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { SPRING_PANEL } from "@/lib/ease"
import { cn } from "@/lib/utils"
import type { AgentChatSkill } from "./types"

export function CreditsTopLayer({
  compact = false,
  creditsRemaining,
  skillsVisible,
  skills,
  selectedSkillIds,
  activeIndex,
  reduce,
  onActiveIndexChange,
  onDismiss,
  onSelect,
  onUpgrade,
}: {
  compact?: boolean
  creditsRemaining: number
  skillsVisible: boolean
  skills: readonly AgentChatSkill[]
  selectedSkillIds: readonly string[]
  activeIndex: number
  reduce?: boolean | null
  onActiveIndexChange: (index: number) => void
  onDismiss?: () => void
  onSelect: (skillId: string) => void
  onUpgrade?: () => void
}) {
  const t = composerText
  const visibleRows = Math.min(Math.max(skills.length, 1), 4)
  const expandedHeight = 40 + visibleRows * 32
  const collapsedHeight = compact ? 0 : 32

  return (
    <div
      data-slot="credits-top-layer"
      data-state={skillsVisible ? "skills" : "credits"}
      className={cn("relative z-20", compact ? "h-0" : "h-8")}
    >
      <AnimatePresence initial={false}>
        {skillsVisible ? (
          <motion.div
            key="skills-panel"
            data-slot="credits-skill-panel"
            initial={reduce ? false : { height: collapsedHeight, opacity: 0.7 }}
            animate={{ height: expandedHeight, opacity: 1 }}
            exit={reduce ? undefined : { height: collapsedHeight, opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_PANEL}
            className="absolute -right-[3px] bottom-0 -left-[3px] overflow-hidden rounded-t-[1.25rem] bg-muted"
          >
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: 6 }}
              transition={reduce ? { duration: 0 } : SPRING_PANEL}
              className="absolute inset-x-0 bottom-0 p-2"
            >
              <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                {t("skills")}
              </p>
              <div className="flex max-h-44 flex-col overflow-y-auto">
                {skills.length > 0 ? (
                  skills.map((skill, index) => {
                    const selected = selectedSkillIds.includes(skill.id)
                    const active = index === activeIndex

                    return (
                      <button
                        key={skill.id}
                        type="button"
                        onPointerEnter={() => onActiveIndexChange(index)}
                        onClick={() => onSelect(skill.id)}
                        className={cn(
                          "flex min-h-9 items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors",
                          active && "bg-background/75"
                        )}
                      >
                        <span className="grid size-6 shrink-0 place-items-center text-muted-foreground">
                          {skill.icon ?? <Box className="size-4" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                          {skill.label}
                        </span>
                        {skill.description ? (
                          <span className="hidden max-w-64 truncate text-xs text-muted-foreground sm:block">
                            {skill.description}
                          </span>
                        ) : null}
                        {selected ? (
                          <Check className="size-4 shrink-0 text-accent" />
                        ) : null}
                      </button>
                    )
                  })
                ) : (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    {t("noSkills")}
                  </p>
                )}
              </div>
            </motion.div>
          </motion.div>
        ) : !compact ? (
          <motion.div
            key="credits"
            initial={reduce ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 5 }}
            transition={reduce ? { duration: 0 } : SPRING_PANEL}
            className="absolute inset-0 flex items-center justify-between gap-3 px-3 text-sm text-muted-foreground sm:px-3.5"
          >
            <span>{t("credits", { count: creditsRemaining })}</span>
            <div className="flex items-center gap-2.5">
              {onUpgrade && (
                <button
                  type="button"
                  onClick={onUpgrade}
                  className="font-medium text-foreground transition-opacity hover:opacity-70 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t("upgrade")}
                </button>
              )}
              {onDismiss && (
                <button
                  type="button"
                  aria-label={t("dismissCredits")}
                  onClick={onDismiss}
                  className="grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
