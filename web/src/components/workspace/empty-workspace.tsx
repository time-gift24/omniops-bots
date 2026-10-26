"use client"
import type { ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { EASE_OUT } from "@/lib/ease"
export function EmptyWorkspace({
  composer,
  suggestions,
  onPrompt,
  disabled,
}: {
  composer: ReactNode
  suggestions: readonly string[]
  onPrompt: (text: string) => void
  disabled: boolean
}) {
  const reduce = useReducedMotion()
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[44rem] flex-col px-4 pt-[clamp(2.75rem,7vh,4.75rem)] pb-4 sm:px-6">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, ease: EASE_OUT }}
        className="text-center"
      >
        <span
          aria-hidden="true"
          className="mx-auto grid size-10 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
        >
          o
        </span>
        <h2 className="mt-4 text-[clamp(1.65rem,4vw,2.15rem)] leading-tight font-medium tracking-[-0.04em] text-balance">
          今天想推进什么？
        </h2>
      </motion.div>
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08, duration: 0.6, ease: EASE_OUT }}
        className="mt-5"
      >
        {composer}
      </motion.div>
      <motion.div
        initial={reduce ? false : "hidden"}
        animate="visible"
        variants={{
          hidden: {},
          visible: {
            transition: { staggerChildren: 0.06, delayChildren: 0.16 },
          },
        }}
        className="mt-3 flex flex-wrap justify-center gap-1.5"
      >
        {suggestions.map((text) => (
          <motion.button
            key={text}
            type="button"
            disabled={disabled}
            onClick={() => onPrompt(text)}
            variants={{
              hidden: { opacity: 0, y: 10 },
              visible: { opacity: 1, y: 0 },
            }}
            transition={{ duration: 0.45, ease: EASE_OUT }}
            className="hover:bg-surface-raised inline-flex min-h-10 items-center gap-2 rounded-full border border-border bg-transparent px-3.5 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
          >
            {text}
          </motion.button>
        ))}
      </motion.div>
    </div>
  )
}
