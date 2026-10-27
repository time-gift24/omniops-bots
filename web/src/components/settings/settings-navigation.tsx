import { useId } from "react"
import { Monitor, Plug, Zap, Wrench, Upload } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { motionTokens } from "@/components/arc/motion-tokens"

export type SettingsSection =
  "theme" | "providers" | "tasks" | "maintenance" | "publication"
export const settingsSections = [
  { id: "theme", label: "主题", icon: Monitor, group: "外观" },
  { id: "providers", label: "Provider", icon: Plug, group: "连接与运行" },
  { id: "tasks", label: "Agent 运行", icon: Zap, group: "连接与运行" },
  { id: "maintenance", label: "连接与维护", icon: Wrench, group: "连接与运行" },
  { id: "publication", label: "资源发布", icon: Upload, group: "连接与运行" },
] as const

export function SettingsNavigation({
  active,
  onNavigate,
}: {
  active: SettingsSection
  onNavigate: (section: SettingsSection) => void
}) {
  const id = useId(),
    reduced = useReducedMotion()
  return (
    <nav aria-label="设置分区" className="settings-navigation">
      {["外观", "连接与运行"].map((group) => (
        <div key={group} className="settings-navigation-group">
          <p>{group}</p>
          {settingsSections
            .filter((item) => item.group === group)
            .map((item) => {
              const Icon = item.icon
              return (
                <a
                  key={item.id}
                  href={`#client-settings-${item.id}`}
                  aria-current={active === item.id ? "location" : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    onNavigate(item.id)
                  }}
                >
                  {active === item.id ? (
                    <motion.span
                      layoutId={id}
                      className="settings-navigation-highlight"
                      transition={
                        reduced ? { duration: 0 } : motionTokens.spring.morph
                      }
                    />
                  ) : null}
                  <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                  <span>{item.label}</span>
                </a>
              )
            })}
        </div>
      ))}
    </nav>
  )
}
