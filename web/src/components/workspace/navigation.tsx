"use client"
import { createPortal } from "react-dom"
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from "react"
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
  useIsPresent,
  type HTMLMotionProps,
} from "motion/react"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  FileTextIcon,
  Folder01Icon,
  HistoryIcon,
  Home01Icon,
  Layers02Icon,
  Settings02Icon,
} from "@hugeicons-pro/core-stroke-rounded"
import { PanelLeft, Search, Plus, X, List } from "lucide-react"
import { Dialog as PrimitiveDialog } from "radix-ui"
import { Button } from "@/components/motion/button"
import { Avatar } from "@/components/arc/avatar/avatar"
import { AnimatedCounter } from "@/components/arc/animated-counter/animated-counter"
import { TextMorph } from "@/components/arc/text-morph/text-morph"
import { Tooltip } from "@/components/arc/tooltip/tooltip"
import { motionTokens } from "@/components/arc/motion-tokens"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"
import { useTitlebarTarget } from "@/components/window-frame"
import { useIsMobile } from "@/components/motion/animated-sidebar"
import {
  MorphicCommandPalette,
  MorphicCommandPaletteContent,
} from "./search-palette"
import { cn } from "@/lib/utils"
import styles from "./sidebar.module.css"
export type SidebarRailItem = {
  id: string
  label: string
  icon?: IconSvgElement
}

export type SidebarRailAction = {
  label: string
  icon?: IconSvgElement
  disabled?: boolean
  onSelect: () => void
}

export type SidebarRailSection = {
  id: string
  label: string
  icon: IconSvgElement
  groups: readonly {
    label: string
    items: readonly SidebarRailItem[]
    /** Extra control rendered beside the group label, e.g. a search button. */
    action?: ReactNode
    /** List groups collapse from their heading; defaults to true. */
    collapsible?: boolean
  }[]
  /** A section can own its rows while still supplying searchable items. */
  renderContent?: (closeNavigation: () => void) => ReactNode
  /** Full-page tools provide their own local navigation. */
  collapseOnSelect?: boolean
  /** Sections with a management list open that list before an individual item. */
  selectFirstItem?: boolean
  /** The section's own list page, rendered below its primary action. */
  overviewLabel?: string
}

export const defaultSections: readonly SidebarRailSection[] = [
  {
    id: "workspace",
    label: "工作区",
    icon: Home01Icon,
    groups: [
      {
        label: "置顶",
        items: [
          { id: "brand-notes", label: "品牌笔记", icon: Folder01Icon },
          { id: "website-refresh", label: "官网改版", icon: Folder01Icon },
        ],
      },
      {
        label: "项目",
        items: [{ id: "fieldwork", label: "实地调研", icon: Folder01Icon }],
      },
      {
        label: "最近",
        items: [
          { id: "launch-direction", label: "发布方向" },
          { id: "research-notes", label: "调研笔记" },
          { id: "campaign-outline", label: "活动大纲" },
          { id: "a-few-good-ideas", label: "一些好点子" },
          { id: "onboarding-checklist", label: "入职清单" },
          { id: "friday-recap", label: "周五复盘" },
        ],
      },
    ],
  },
  {
    id: "library",
    label: "资料库",
    icon: Layers02Icon,
    groups: [
      {
        label: "合集",
        items: [
          { id: "references", label: "参考资料", icon: BookOpen01Icon },
          { id: "saved-pages", label: "收藏的页面", icon: FileTextIcon },
          { id: "assets", label: "素材", icon: Folder01Icon },
        ],
      },
    ],
  },
  {
    id: "activity",
    label: "动态",
    icon: HistoryIcon,
    groups: [
      {
        label: "更新",
        items: [
          { id: "this-week", label: "本周", icon: HistoryIcon },
          { id: "shared-with-you", label: "与我共享", icon: FileTextIcon },
          { id: "archive", label: "归档", icon: Folder01Icon },
        ],
      },
    ],
  },
  {
    id: "settings",
    label: "设置",
    icon: Settings02Icon,
    groups: [
      {
        label: "工作区",
        items: [
          { id: "preferences", label: "偏好设置", icon: Settings02Icon },
          { id: "members", label: "成员", icon: Home01Icon },
          { id: "connections", label: "连接", icon: Layers02Icon },
        ],
      },
    ],
  },
]

export type SidebarRailProps = {
  workspaceName?: string
  sections?: readonly SidebarRailSection[]
  /** The active section's primary action, keyed by section id. */
  actions?: Partial<Record<string, SidebarRailAction>>
  defaultExpanded?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  defaultItemId?: string
  activeSectionId?: string
  activeItemId?: string
  onSectionSelect?: (section: SidebarRailSection) => void
  onParentSelect?: (section: SidebarRailSection) => void
  onItemSelect?: (item: SidebarRailItem, section: SidebarRailSection) => void
  account?: { name: string; initials: string }
  onAccountClick?: () => void
  /** Replaces the panel title; search and collapse controls stay built in. Pass null to hide it. */
  panelHeader?: ReactNode
  /** Replaces the account control at the bottom of the icon rail. Pass null to hide it. */
  railFooter?: ReactNode
  /** Extra controls above the account at the bottom of the icon rail. */
  railActions?: ReactNode
  /** Replaces the workspace breadcrumbs; the navigation toggle stays built in. Pass null to hide them. */
  workspaceHeader?: ReactNode
  /** Shared header spacing, including room for floating controls on every page. */
  workspaceHeaderClassName?: string
  /** Hides header/content interactions beneath a mobile end-panel overlay. */
  workspaceInert?: boolean
  /** Full-height column rendered after the header+content column, e.g. the workbench panel. */
  endPanel?: ReactNode
  /** Absolutely positioned overlay on the header+content column, e.g. a floating toggle over the header. Positioning classes are the caller's responsibility. */
  headerOverlay?: ReactNode
  /** Overrides the content wrapper padding; chat-like surfaces pass p-0 and own their padding. */
  contentClassName?: string
  children?: ReactNode
  className?: string
}

const NavigationSheet = forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
  function NavigationSheet(props, ref) {
    const present = useIsPresent()
    return (
      <motion.div
        {...props}
        ref={ref}
        aria-hidden={!present}
        inert={!present}
      />
    )
  }
)

function NavGroup({
  group,
  active,
  onSelect,
}: {
  group: SidebarRailSection["groups"][number]
  active: string
  onSelect: (item: SidebarRailItem) => void
}) {
  const [open, setOpen] = useState(true),
    id = useId(),
    reduce = useReducedMotion()
  return (
    <section className={styles.section}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            if (group.collapsible !== false) setOpen(!open)
          }}
          className="flex h-9 min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-xs text-muted-foreground"
        >
          <motion.span
            animate={{ rotate: open ? 0 : -90 }}
            transition={reduce ? { duration: 0 } : motionTokens.spring.snappy}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
          </motion.span>
          <span className="truncate">{group.label}</span>
          {group.items.length ? (
            <AnimatedCounter
              value={group.items.length}
              className="ml-auto text-xs text-muted-foreground"
            />
          ) : null}
        </button>
        {group.action}
      </div>
      <motion.ul
        id={id}
        inert={!open}
        aria-hidden={!open}
        className={cn(styles.list, "overflow-hidden")}
        initial={false}
        animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
      >
        {group.items.map((item) => (
          <li key={item.id} className={styles.item}>
            <button
              type="button"
              className={styles.row}
              aria-current={item.id === active ? "page" : undefined}
              onClick={() => onSelect(item)}
            >
              {item.id === active ? (
                <motion.span
                  layoutId="navigation-current"
                  className={styles.highlight}
                  transition={
                    reduce ? { duration: 0 } : motionTokens.spring.morph
                  }
                />
              ) : null}
              {item.icon ? (
                <HugeiconsIcon
                  icon={item.icon}
                  size={16}
                  className={styles.lead}
                />
              ) : null}
              <span className={styles.name}>{item.label}</span>
            </button>
          </li>
        ))}
      </motion.ul>
    </section>
  )
}
export function SidebarRail({
  workspaceName = "omniops-bots",
  sections = defaultSections,
  actions,
  defaultExpanded = true,
  expanded: controlled,
  onExpandedChange,
  defaultItemId = "",
  activeSectionId,
  activeItemId,
  onSectionSelect,
  onParentSelect,
  onItemSelect,
  account = { name: "陈晓", initials: "陈" },
  onAccountClick,
  panelHeader,
  railFooter,
  railActions,
  workspaceHeader,
  workspaceHeaderClassName,
  workspaceInert,
  endPanel,
  headerOverlay,
  contentClassName,
  children,
  className,
}: SidebarRailProps) {
  const [internal, setInternal] = useState(defaultExpanded),
    expanded = controlled ?? internal
  const [internalSection, setSection] = useState(sections[0]?.id),
    [internalItem, setItem] = useState(defaultItemId)
  const [mobileOpen, setMobileOpen] = useState(false),
    [peek, setPeek] = useState(false),
    [searchOpen, setSearchOpen] = useState(false)
  const [width, setWidth] = useState(272),
    [resizing, setResizing] = useState(false)
  const mobile = useIsMobile(),
    reduce = useReducedMotion(),
    titlebar = useTitlebarTarget(),
    toggle = useRef<HTMLButtonElement>(null),
    panelId = useId()
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const section =
    sections.find((x) => x.id === (activeSectionId ?? internalSection)) ??
    sections[0]
  const itemId = activeItemId ?? internalItem,
    action = section ? actions?.[section.id] : undefined
  const selected = section?.groups
    .flatMap((x) => x.items)
    .find((x) => x.id === itemId)
  const panelOpen = mobile ? mobileOpen : expanded || peek
  const clamp = (next: number) =>
    Math.round(Math.max(240, Math.min(next, 420, window.innerWidth - 420)))
  const setExpanded = useCallback(
    (next: boolean) => {
      if (controlled === undefined) setInternal(next)
      onExpandedChange?.(next)
      if (!next) toggle.current?.focus({ preventScroll: true })
      setPeek(false)
    },
    [controlled, onExpandedChange]
  )
  function closeNavigation() {
    setMobileOpen(false)
    if (!expanded) setPeek(false)
  }
  function selectSection(entry: SidebarRailSection) {
    setSection(entry.id)
    onSectionSelect?.(entry)
    if (
      entry.id !== section?.id &&
      !entry.renderContent &&
      entry.selectFirstItem !== false
    ) {
      const first = entry.groups[0]?.items[0]
      if (first) {
        setItem(first.id)
        onItemSelect?.(first, entry)
      }
    }
    if (entry.collapseOnSelect) {
      setExpanded(false)
      closeNavigation()
    } else if (mobile) setMobileOpen(true)
    else setExpanded(true)
  }
  function selectItem(item: SidebarRailItem) {
    setItem(item.id)
    if (section) onItemSelect?.(item, section)
    if (section?.collapseOnSelect) setExpanded(false)
    closeNavigation()
  }
  function overview(entry: SidebarRailSection) {
    setSection(entry.id)
    setItem("")
    ;(onParentSelect ?? onSectionSelect)?.(entry)
    closeNavigation()
  }
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey)
      )
        return
      const modal =
        event.target instanceof Element
          ? event.target.closest(
              '[aria-modal="true"]:not([data-mobile="true"])'
            )
          : null
      if (modal && !modal.querySelector('[data-slot="command"]')) return
      if (event.key.toLowerCase() === "k") {
        event.preventDefault()
        setSearchOpen((value) => !value)
      }
      if (event.key.toLowerCase() === "b") {
        event.preventDefault()
        if (mobile) setMobileOpen((value) => !value)
        else setExpanded(!expanded)
      }
    }
    window.addEventListener("keydown", listener)
    return () => window.removeEventListener("keydown", listener)
  }, [expanded, mobile, setExpanded])
  useEffect(() => {
    if (!resizing) return
    const value = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.userSelect = value
    }
  }, [resizing])
  const header = (
    <header
      inert={workspaceInert}
      className="relative flex min-h-12 shrink-0 items-center gap-3 px-3 sm:px-4"
    >
      <Button
        ref={toggle}
        variant="ghost"
        size="icon"
        aria-label={!mobile && expanded ? "收起导航" : "展开导航"}
        aria-expanded={panelOpen}
        aria-controls={panelId}
        onClick={() =>
          mobile ? setMobileOpen(!mobileOpen) : setExpanded(!expanded)
        }
      >
        <PanelLeft size={16} />
      </Button>
      <div
        data-slot="sidebar-rail-workspace-header"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3",
          workspaceHeaderClassName
        )}
      >
        {workspaceHeader === undefined ? (
          <Breadcrumbs
            items={[
              {
                label: section?.label ?? "工作区",
                onSelect:
                  section && onParentSelect
                    ? () => overview(section)
                    : undefined,
              },
              { label: selected?.label ?? "工作区" },
            ]}
          />
        ) : (
          workspaceHeader
        )}
      </div>
      {titlebar ? headerOverlay : null}
    </header>
  )
  const panel = (
    <div
      id={panelId}
      data-slot="sidebar"
      className={cn(styles.sidebar, "h-full w-full")}
      style={{ width: "100%", height: "100%" }}
    >
      <div data-slot="sidebar-header" className={styles.header}>
        <div className="flex items-center gap-2">
          <div
            data-slot="sidebar-rail-panel-header"
            className="flex min-w-0 flex-1 items-center gap-2.5 py-2"
          >
            {panelHeader === undefined ? (
              <>
                <span className={styles.mark}>o</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    <TextMorph>{workspaceName}</TextMorph>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    本地工作台
                  </span>
                </span>
              </>
            ) : (
              panelHeader
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="搜索导航"
            aria-haspopup="dialog"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={16} />
          </Button>
          {mobile ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close sidebar"
              onClick={() => setMobileOpen(false)}
            >
              <X size={16} />
            </Button>
          ) : null}
        </div>
        <nav
          aria-label={!mobile && expanded ? "工作区导航区域" : "栏目"}
          className="mb-2 grid gap-px border-b border-border pb-3"
        >
          {sections.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-label={entry.label}
              aria-current={entry.id === section?.id ? "page" : undefined}
              className={styles.row}
              onClick={() => selectSection(entry)}
            >
              {entry.id === section?.id ? (
                <motion.span
                  layoutId="navigation-section"
                  className={styles.highlight}
                  transition={
                    reduce ? { duration: 0 } : motionTokens.spring.morph
                  }
                />
              ) : null}
              <HugeiconsIcon
                icon={entry.icon}
                size={16}
                className={styles.lead}
              />
              <span className={styles.name}>{entry.label}</span>
            </button>
          ))}
        </nav>
        {action ? (
          <Button
            variant="ghost"
            disabled={action.disabled}
            onClick={() => {
              action.onSelect()
              closeNavigation()
            }}
            className="w-full justify-start gap-2 px-3"
          >
            {action.icon ? (
              <HugeiconsIcon icon={action.icon} size={16} />
            ) : (
              <Plus size={16} />
            )}
            {action.label}
          </Button>
        ) : null}
        {section?.overviewLabel ? (
          <Button
            variant="ghost"
            aria-current={itemId === "" ? "page" : undefined}
            className={cn(
              "w-full justify-start gap-2 px-3",
              itemId === "" && "bg-accent"
            )}
            onClick={() => overview(section)}
          >
            <List size={16} />
            {section.overviewLabel}
          </Button>
        ) : null}
      </div>
      <div className={styles.scroll}>
        {section?.renderContent
          ? section.renderContent(closeNavigation)
          : section?.groups.map((group) => (
              <NavGroup
                key={`${section.id}:${group.label}`}
                group={group}
                active={itemId}
                onSelect={selectItem}
              />
            ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-3">
        {railFooter === undefined ? (
          <Button
            variant="ghost"
            aria-label={`账户：${account.name}`}
            onClick={onAccountClick}
            className="min-w-0 flex-1 justify-start gap-2.5 px-1"
          >
            <Avatar name={account.name} size="sm" />
            <span className="truncate">{account.name}</span>
          </Button>
        ) : (
          railFooter
        )}
        {railActions}
      </div>
    </div>
  )
  function endResize(event: PointerEvent<HTMLElement>) {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return (
    <LayoutGroup>
      <div
        data-slot="sidebar-wrapper"
        data-state={panelOpen ? "expanded" : "collapsed"}
        className={cn(
          "relative flex min-h-0 w-full overflow-hidden bg-background",
          titlebar ? "h-full" : "h-dvh",
          className
        )}
      >
        <motion.div
          data-rail-state={expanded ? "expanded" : "collapsed"}
          data-peeking={!expanded && peek ? "true" : "false"}
          className="relative z-20 h-full shrink-0"
          initial={false}
          animate={{ width: mobile ? 64 : expanded ? width : 64 }}
          transition={
            reduce || resizing ? { duration: 0 } : motionTokens.spring.smooth
          }
          onFocusCapture={(event) => {
            if (!mobile && !expanded && event.target.matches(":focus-visible"))
              setPeek(true)
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setPeek(false)
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !expanded) {
              event.preventDefault()
              setPeek(false)
              toggle.current?.focus()
            }
          }}
        >
          {!expanded || mobile ? (
            <nav
              aria-label="工作区导航区域"
              className="flex h-full w-16 flex-col items-center gap-4 border-r border-border bg-sidebar py-4"
            >
              {sections.map((entry) => (
                <Tooltip key={entry.id} content={entry.label} side="right">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={entry.label}
                    aria-current={section?.id === entry.id ? "page" : undefined}
                    onClick={() => selectSection(entry)}
                  >
                    <HugeiconsIcon icon={entry.icon} size={18} />
                  </Button>
                </Tooltip>
              ))}
              <div className="mt-auto flex flex-col gap-3">
                {railActions}
                {railFooter === undefined ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`账户：${account.name}`}
                    onClick={onAccountClick}
                  >
                    {account.initials}
                  </Button>
                ) : (
                  railFooter
                )}
              </div>
            </nav>
          ) : null}
          {!mobile ? (
            <motion.div
              inert={!panelOpen}
              aria-hidden={!panelOpen}
              className={cn(
                "absolute inset-y-0",
                expanded ? "left-0" : "left-16 shadow-xl"
              )}
              style={{ width }}
              initial={false}
              animate={{ opacity: panelOpen ? 1 : 0, x: panelOpen ? 0 : -8 }}
              transition={reduce ? { duration: 0 } : motionTokens.spring.smooth}
            >
              {panel}
            </motion.div>
          ) : null}
          {!mobile && expanded ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="调整导航宽度"
              aria-valuenow={width}
              aria-valuemin={240}
              aria-valuemax={420}
              tabIndex={0}
              data-slot="sidebar-resize-handle"
              className="absolute inset-y-0 right-0 z-40 w-2 translate-x-1/2 cursor-col-resize touch-none focus-visible:bg-primary/20"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                drag.current = { id: event.pointerId, x: event.clientX, width }
                setResizing(true)
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (drag.current?.id === event.pointerId)
                  setWidth(
                    clamp(drag.current.width + event.clientX - drag.current.x)
                  )
              }}
              onPointerUp={endResize}
              onPointerCancel={endResize}
              onDoubleClick={() => setWidth(272)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault()
                  setWidth(
                    clamp(
                      width +
                        (event.key === "ArrowRight" ? 1 : -1) *
                          (event.shiftKey ? 64 : 16)
                    )
                  )
                }
              }}
            />
          ) : null}
        </motion.div>
        {mobile ? (
          <PrimitiveDialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
            <AnimatePresence>
              {mobileOpen ? (
                <PrimitiveDialog.Portal forceMount key="navigation">
                  <PrimitiveDialog.Overlay asChild forceMount>
                    <motion.div
                      className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{
                        duration: reduce ? 0 : motionTokens.duration.fast,
                      }}
                    />
                  </PrimitiveDialog.Overlay>
                  <PrimitiveDialog.Content
                    aria-modal="true"
                    asChild
                    forceMount
                    onCloseAutoFocus={(event) => {
                      event.preventDefault()
                      if (
                        !document.querySelector(
                          '[aria-modal="true"]:not([data-mobile="true"])'
                        )
                      )
                        toggle.current?.focus({ preventScroll: true })
                    }}
                  >
                    <NavigationSheet
                      data-mobile="true"
                      data-slot="sidebar-mobile"
                      aria-hidden="false"
                      className="fixed inset-y-0 left-0 z-50 w-[min(85vw,19rem)] outline-none"
                      initial={{ x: "-100%" }}
                      animate={{ x: 0 }}
                      exit={{ x: "-100%" }}
                      transition={
                        reduce ? { duration: 0 } : motionTokens.spring.smooth
                      }
                    >
                      <PrimitiveDialog.Title className="sr-only">
                        导航
                      </PrimitiveDialog.Title>
                      <PrimitiveDialog.Description className="sr-only">
                        工作区与资源
                      </PrimitiveDialog.Description>
                      {panel}
                    </NavigationSheet>
                  </PrimitiveDialog.Content>
                </PrimitiveDialog.Portal>
              ) : null}
            </AnimatePresence>
            {!mobileOpen ? (
              <div data-mobile="true" aria-hidden="true" hidden />
            ) : null}
          </PrimitiveDialog.Root>
        ) : null}
        <div
          inert={workspaceInert}
          className="relative flex min-w-0 flex-1 flex-col"
        >
          {titlebar ? createPortal(header, titlebar) : header}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto p-4 sm:p-8",
              contentClassName
            )}
          >
            {children}
          </div>
          {titlebar ? null : headerOverlay}
        </div>
        {endPanel}
        <MorphicCommandPalette
          open={searchOpen}
          onOpenChange={setSearchOpen}
          shortcut={false}
          fallbackFocusRef={toggle}
          items={sections.flatMap((entry) => [
            ...(entry.overviewLabel
              ? [
                  {
                    id: `overview:${entry.id}`,
                    label: entry.overviewLabel,
                    group: "页面",
                    onSelect: () => overview(entry),
                  },
                ]
              : []),
            ...entry.groups.flatMap((group) =>
              group.items.map((item) => ({
                id: `${entry.id}:${group.label}:${item.id}`,
                label: item.label,
                group: `${entry.label} · ${group.label}`,
                keywords: [entry.label, group.label],
                onSelect: () => {
                  setSection(entry.id)
                  setItem(item.id)
                  onItemSelect?.(item, entry)
                  closeNavigation()
                },
              }))
            ),
          ])}
        >
          <MorphicCommandPaletteContent
            title="搜索导航"
            description="搜索可用页面"
            placeholder="查找页面…"
            emptyMessage="没有找到页面。"
          />
        </MorphicCommandPalette>
      </div>
    </LayoutGroup>
  )
}
