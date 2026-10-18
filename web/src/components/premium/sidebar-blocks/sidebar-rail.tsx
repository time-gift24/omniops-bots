"use client";

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  ArrowUpRight01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  FileTextIcon,
  Folder01Icon,
  HistoryIcon,
  Home01Icon,
  Layers02Icon,
  PanelLeftIcon,
  PlusSignIcon,
  Search01Icon,
  Settings02Icon,
} from "@hugeicons-pro/core-stroke-rounded";
import { motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  AnimatedSidebar,
  AnimatedSidebarClose,
  AnimatedSidebarContent,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
  AnimatedSidebarHeader,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarProvider,
  useAnimatedSidebar,
} from "@/components/motion/animated-sidebar";
import { Button } from "@/components/motion/button";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { SharedLayoutBg } from "@/components/motion/shared-layout-bg";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  MorphicTooltip,
  MorphicTooltipProvider,
} from "@/components/premium/morphic-tooltip/morphic-tooltip";
import { SPRING_PANEL } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type SidebarRailItem = {
  id: string;
  label: string;
  icon?: IconSvgElement;
};

export type SidebarRailSection = {
  id: string;
  label: string;
  icon: IconSvgElement;
  groups: readonly {
    label: string;
    items: readonly SidebarRailItem[];
    /** Extra control rendered beside the group label, e.g. a search button. */
    action?: ReactNode;
  }[];
  /** A section can own its rows while still supplying searchable items. */
  renderContent?: (closeNavigation: () => void) => ReactNode;
  /** Full-page tools provide their own local navigation. */
  collapseOnSelect?: boolean;
  /** Sections with a management list open that list before an individual item. */
  selectFirstItem?: boolean;
};

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
];

export type SidebarRailProps = {
  workspaceName?: string;
  sections?: readonly SidebarRailSection[];
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  defaultItemId?: string;
  activeSectionId?: string;
  activeItemId?: string;
  onSectionSelect?: (section: SidebarRailSection) => void;
  onParentSelect?: (section: SidebarRailSection) => void;
  onItemSelect?: (item: SidebarRailItem, section: SidebarRailSection) => void;
  onCreate?: () => void;
  createLabel?: string;
  account?: { name: string; initials: string };
  onAccountClick?: () => void;
  /** Replaces the panel title; search and collapse controls stay built in. Pass null to hide it. */
  panelHeader?: ReactNode;
  /** Replaces the account control at the bottom of the icon rail. Pass null to hide it. */
  railFooter?: ReactNode;
  /** Extra controls above the account at the bottom of the icon rail. */
  railActions?: ReactNode;
  /** Replaces the workspace breadcrumbs; the navigation toggle stays built in. Pass null to hide them. */
  workspaceHeader?: ReactNode;
  /** Shared header spacing, including room for floating controls on every page. */
  workspaceHeaderClassName?: string;
  /** Full-height column rendered after the header+content column, e.g. the workbench panel. */
  endPanel?: ReactNode;
  /** Absolutely positioned overlay on the header+content column, e.g. a floating toggle over the header. Positioning classes are the caller's responsibility. */
  headerOverlay?: ReactNode;
  /** Overrides the content wrapper padding; chat-like surfaces pass p-0 and own their padding. */
  contentClassName?: string;
  children?: ReactNode;
  className?: string;
};

const iconButtonClass =
  "size-9 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SidebarRail({
  defaultExpanded = true,
  expanded: controlledExpanded,
  onExpandedChange,
  className,
  ...props
}: SidebarRailProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const [focused, setFocused] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const expanded = controlledExpanded ?? internalExpanded;

  function setExpanded(next: boolean) {
    if (!next) toggleRef.current?.focus({ preventScroll: true });
    if (controlledExpanded === undefined) setInternalExpanded(next);
    onExpandedChange?.(next);
    setFocused(false);
  }

  return (
    <div className={cn("h-dvh w-full", className)}>
      <MorphicTooltipProvider>
        <AnimatedSidebarProvider
          open={expanded || focused}
          onOpenChange={setExpanded}
          style={{
            "--sidebar-width": "17rem",
            "--sidebar-width-mobile": "19rem",
          }}
          className="relative h-full min-h-0 overflow-hidden bg-background"
        >
          <SidebarRailShell
            {...props}
            expanded={expanded}
            setExpanded={setExpanded}
            setFocused={setFocused}
            toggleRef={toggleRef}
          />
        </AnimatedSidebarProvider>
      </MorphicTooltipProvider>
    </div>
  );
}

function SidebarRailShell({
  workspaceName = "omniops-bots",
  sections = defaultSections,
  defaultItemId = "launch-direction",
  activeSectionId,
  activeItemId,
  onSectionSelect,
  onParentSelect,
  onItemSelect,
  onCreate,
  createLabel = "新建页面",
  account = { name: "陈晓", initials: "陈" },
  onAccountClick,
  panelHeader,
  railFooter,
  railActions,
  workspaceHeader,
  workspaceHeaderClassName,
  endPanel,
  headerOverlay,
  contentClassName,
  children,
  expanded,
  setExpanded,
  setFocused,
  toggleRef,
}: Omit<SidebarRailProps, "expanded" | "onExpandedChange"> & {
  expanded: boolean;
  setExpanded: (next: boolean) => void;
  setFocused: (next: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const context = useAnimatedSidebar();
  const { triggerRef } = context;
  const reduce = useReducedMotion();
  const [internalSectionId, setSectionId] = useState(sections[0]?.id);
  const [internalItemId, setItemId] = useState(defaultItemId);
  const sectionId = activeSectionId ?? internalSectionId;
  const itemId = activeItemId ?? internalItemId;
  const [searchOpen, setSearchOpen] = useState(false);
  const panelId = useId();
  const section =
    sections.find((entry) => entry.id === sectionId) ?? sections[0];
  const selectedItem = section?.groups
    .flatMap((group) => group.items)
    .find((item) => item.id === itemId);
  const groups = section?.groups ?? [];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      )
        return;
      const modal =
        event.target instanceof Element
          ? event.target.closest(
              '[aria-modal="true"]:not([data-mobile="true"])',
            )
          : null;
      if (modal && !modal.querySelector('[data-slot="command"]')) return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function closePeek() {
    setFocused(false);
  }

  function closeNavigation() {
    context.setOpenMobile(false);
    if (!expanded && !context.isMobile) closePeek();
  }

  function toggleExpanded() {
    setExpanded(!expanded);
  }

  function selectItem(item: SidebarRailItem) {
    if (!section) return;
    setItemId(item.id);
    onItemSelect?.(item, section);
    if (section.collapseOnSelect) setExpanded(false);
    if (!expanded && !context.isMobile) {
      toggleRef.current?.focus({ preventScroll: true });
      closePeek();
    }
  }

  function selectSearchItem(target: SidebarRailSection, item: SidebarRailItem) {
    setSectionId(target.id);
    setItemId(item.id);
    onItemSelect?.(item, target);
    if (target.collapseOnSelect) setExpanded(false);
    setSearchOpen(false);
    context.setOpenMobile(false);
    if (!expanded && !context.isMobile) {
      toggleRef.current?.focus({ preventScroll: true });
      closePeek();
    }
  }

  const panelHeaderNode = (
    <AnimatedSidebarHeader className="gap-3 p-4 pb-2">
      <div className="flex items-center gap-1">
        <div data-slot="sidebar-rail-panel-header" className="min-w-0 flex-1">
          {panelHeader === undefined ? (
            <h2 className="truncate text-xl font-medium">{workspaceName}</h2>
          ) : (
            panelHeader
          )}
        </div>
        <MorphicTooltip
          content="搜索导航（⌘K）"
          side="bottom"
          disabled={context.isMobile}
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label="搜索导航"
            aria-haspopup="dialog"
            onClick={() => setSearchOpen(true)}
            className={iconButtonClass}
          >
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" size={16} />
          </Button>
        </MorphicTooltip>
        <AnimatedSidebarClose className="size-9 rounded-full text-muted-foreground hover:bg-muted md:hidden">
          <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" size={16} />
        </AnimatedSidebarClose>
      </div>
      <Button
        variant="ghost"
        onClick={() => {
          setItemId("new-page");
          if (onCreate) setSectionId(sections[0]?.id);
          onCreate?.();
          context.setOpenMobile(false);
          if (!expanded && !context.isMobile) {
            toggleRef.current?.focus({ preventScroll: true });
            closePeek();
          }
        }}
        className="h-9 justify-start rounded-full px-2 text-foreground"
      >
        <HugeiconsIcon icon={PlusSignIcon} aria-hidden="true" size={16} />
        {createLabel}
      </Button>
    </AnimatedSidebarHeader>
  );

  return (
    <>
      <motion.div
        initial={false}
        animate={{ width: !context.isMobile && expanded ? "21.5rem" : "4rem" }}
        transition={reduce ? { duration: 0 } : SPRING_PANEL}
        data-rail-state={expanded ? "expanded" : "collapsed"}
        data-peeking={!expanded && context.open ? "true" : "false"}
        className="relative z-20 h-full shrink-0 max-md:w-16!"
        onFocusCapture={(event) => {
          if (!context.isMobile && event.target.matches(":focus-visible")) {
            setFocused(true);
          }
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !expanded && !context.isMobile) {
            event.preventDefault();
            toggleRef.current?.focus({ preventScroll: true });
            closePeek();
          }
        }}
      >
        <nav
          aria-label="工作区导航区域"
          className="relative z-30 flex h-full w-16 flex-col items-center gap-4 border-r border-sidebar-border bg-sidebar py-4"
        >
          {sections.map((entry) => {
            const Icon = entry.icon;
            const active = section?.id === entry.id;
            return (
              <MorphicTooltip
                key={entry.id}
                content={entry.label}
                side="right"
                disabled={context.isMobile}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={entry.label}
                  aria-current={active ? "page" : undefined}
                  aria-controls={context.isMobile ? undefined : panelId}
                  aria-expanded={
                    active &&
                    (context.isMobile ? context.openMobile : context.open)
                  }
                  onClick={(event) => {
                    setSectionId(entry.id);
                    onSectionSelect?.(entry);
                    if (entry.id !== section?.id && !entry.renderContent && entry.selectFirstItem !== false) {
                      const firstItem = entry.groups[0]?.items[0];
                      if (firstItem) {
                        setItemId(firstItem.id);
                        onItemSelect?.(firstItem, entry);
                      }
                    }
                    if (entry.collapseOnSelect) {
                      context.setOpenMobile(false);
                      setExpanded(false);
                    } else if (context.isMobile) {
                      triggerRef.current = event.currentTarget;
                      context.setOpenMobile(true);
                    } else setExpanded(true);
                  }}
                  className={cn(
                    iconButtonClass,
                    active && "bg-accent text-accent-foreground",
                  )}
                >
                  <HugeiconsIcon
                    icon={Icon}
                    aria-hidden="true"
                    size={20}
                    strokeWidth={1.7}
                  />
                </Button>
              </MorphicTooltip>
            );
          })}
          <div data-slot="sidebar-rail-footer" className="mt-auto flex flex-col items-center gap-3">
            {railActions}
            {railFooter === undefined ? (
              <MorphicTooltip
                content={account.name}
                side="right"
                disabled={context.isMobile}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`账户：${account.name}`}
                  onClick={onAccountClick}
                  className={cn(
                    iconButtonClass,
                    "border border-border text-xs text-foreground",
                  )}
                >
                  {account.initials}
                </Button>
              </MorphicTooltip>
            ) : (
              railFooter
            )}
          </div>
        </nav>

        <AnimatedSidebar
          id={panelId}
          ariaLabel={`${workspaceName} 导航`}
          collapsible="offcanvas"
          className="w-76 shadow-none md:absolute md:inset-y-0 md:left-16 md:w-auto"
          panelClassName={cn(
            "static h-full border-r border-sidebar-border bg-sidebar shadow-none",
            !expanded && context.open && "bg-popover shadow-md",
          )}
        >
          {panelHeaderNode}

          <AnimatedSidebarContent className="gap-5 px-2 pt-3 pb-5">
            {section?.renderContent
              ? section.renderContent(closeNavigation)
              : groups.map((group) => (
                  <AnimatedSidebarGroup key={group.label} className="gap-2 p-0">
                    <div className="flex items-center gap-1 pr-1">
                      <AnimatedSidebarGroupLabel className="min-w-0 flex-1 px-3 text-xs font-medium text-muted-foreground">
                        {group.label}
                      </AnimatedSidebarGroupLabel>
                      {group.action}
                    </div>
                    <AnimatedSidebarGroupContent>
                      <SharedLayoutBg
                        as="ul"
                        inset={0}
                        pillClassName="rounded-full bg-muted/70"
                        pillContainerClassName="inset-y-auto top-0 h-9"
                        className="flex w-full min-w-0 list-none flex-col gap-0.5"
                      >
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          return (
                            <AnimatedSidebarMenuItem key={item.id}>
                              <AnimatedSidebarMenuButton
                                icon={
                                  Icon ? (
                                    <HugeiconsIcon
                                      icon={Icon}
                                      aria-hidden="true"
                                      size={16}
                                      strokeWidth={1.7}
                                    />
                                  ) : undefined
                                }
                                isActive={item.id === itemId}
                                onSelect={() => selectItem(item)}
                                className="rounded-full font-normal [&>span]:rounded-full"
                              >
                                {item.label}
                              </AnimatedSidebarMenuButton>
                            </AnimatedSidebarMenuItem>
                          );
                        })}
                      </SharedLayoutBg>
                    </AnimatedSidebarGroupContent>
                  </AnimatedSidebarGroup>
                ))}
            {!section?.renderContent && groups.length === 0 ? (
              <output className="px-3 py-4 text-sm text-muted-foreground">
                没有找到页面。
              </output>
            ) : null}
          </AnimatedSidebarContent>
        </AnimatedSidebar>
      </motion.div>

      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="搜索导航"
        description="搜索可用页面"
        fallbackFocusRef={toggleRef}
      >
        <CommandInput
          placeholder="查找页面…"
          wrapperClassName="h-12 rounded-none border-0 border-b border-border bg-transparent px-4 focus-within:ring-0"
        />
        <CommandList className="max-h-[min(24rem,60dvh)]">
          <CommandEmpty>没有找到页面。</CommandEmpty>
          {sections.map((entry) =>
            entry.groups.map((group) => (
              <CommandGroup
                key={`${entry.id}:${group.label}`}
                heading={`${entry.label} · ${group.label}`}
              >
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <CommandItem
                      key={item.id}
                      value={`${item.label} ${entry.label} ${group.label} ${entry.id} ${item.id}`}
                      onSelect={() => selectSearchItem(entry, item)}
                    >
                      {Icon ? (
                        <HugeiconsIcon
                          icon={Icon}
                          aria-hidden="true"
                          size={16}
                          strokeWidth={1.7}
                          className="text-muted-foreground"
                        />
                      ) : null}
                      <span className="truncate">{item.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )),
          )}
        </CommandList>
      </CommandDialog>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 shrink-0 items-center gap-3 px-3 sm:px-4">
          <MorphicTooltip
            content={expanded ? "收起导航" : "展开导航"}
            side="bottom"
            disabled={context.isMobile}
          >
            <Button
              ref={toggleRef}
              variant="ghost"
              size="icon"
              aria-label={
                expanded && !context.isMobile ? "收起导航" : "展开导航"
              }
              aria-controls={context.isMobile ? undefined : panelId}
              aria-expanded={context.isMobile ? context.openMobile : expanded}
              onClick={(event) => {
                if (context.isMobile) {
                  triggerRef.current = event.currentTarget;
                  context.setOpenMobile(!context.openMobile);
                } else toggleExpanded();
              }}
              className={iconButtonClass}
            >
              <HugeiconsIcon
                icon={PanelLeftIcon}
                aria-hidden="true"
                size={16}
              />
            </Button>
          </MorphicTooltip>
          <div
            data-slot="sidebar-rail-workspace-header"
            className={cn(
              "flex min-w-0 flex-1 items-center gap-3",
              workspaceHeaderClassName,
            )}
          >
            {workspaceHeader === undefined ? (
              <Breadcrumbs
                items={[
                  {
                    label: section?.label ?? "工作区",
                    onSelect:
                      onParentSelect && section
                        ? () => onParentSelect(section)
                        : undefined,
                  },
                  {
                    label:
                      itemId === "new-page"
                        ? "未命名页面"
                        : (selectedItem?.label ?? "工作区"),
                  },
                ]}
              />
            ) : (
              workspaceHeader
            )}
          </div>
        </header>
        <div
          className={cn(
            "min-h-0 flex-1 overflow-auto p-4 pt-6 sm:p-8 sm:pt-8",
            contentClassName,
          )}
        >
          {children ?? (
            <div className="grid h-full place-content-center gap-3 text-center">
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-border text-muted-foreground">
                <HugeiconsIcon
                  icon={ArrowUpRight01Icon}
                  aria-hidden="true"
                  size={20}
                />
              </span>
              <h3 className="text-xl font-medium">
                {selectedItem?.label ?? "下一个想法从这里开始"}
              </h3>
              <p className="max-w-xs text-sm text-muted-foreground">
                项目、页面和资料，触手可及。
              </p>
            </div>
          )}
        </div>
        {headerOverlay}
      </div>

      {endPanel}
    </>
  );
}
