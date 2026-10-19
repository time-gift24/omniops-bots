"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons-pro/core-stroke-rounded";
import { Command as CommandPrimitive } from "cmdk";
import { useEffect, useLayoutEffect, useRef, type ComponentProps, type RefObject } from "react";
import {
  AnimatedModal,
  AnimatedModalDescription,
  AnimatedModalTitle,
} from "@/components/motion/animated-modal";
import { cn } from "@/lib/utils";

function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "搜索导航",
  description = "搜索页面、资料库和设置",
  children,
  className,
  showCloseButton = false,
  fallbackFocusRef,
  open,
  onOpenChange,
  ...props
}: Pick<ComponentProps<typeof AnimatedModal>, "open" | "onOpenChange" | "children"> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const commandRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !commandRef.current?.contains(active)) {
        previousFocus.current = active;
      }
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // Search keeps its input focus on touch devices, where Headless UI focuses the dialog.
    const frame = requestAnimationFrame(() => {
      commandRef.current?.querySelector<HTMLInputElement>('[data-slot="command-input"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <AnimatedModal
      {...props}
      open={open}
      onOpenChange={onOpenChange}
      panelClassName={cn("overflow-hidden p-0", className)}
      panelDataSlot="dialog-content"
      showCloseButton={showCloseButton}
      onExitComplete={() => {
        const previous = previousFocus.current;
        // The opener may now belong to a closed drawer or desktop peek.
        const target = previous?.isConnected && !previous.closest("[inert]") && previous.getClientRects().length
          ? previous
          : fallbackFocusRef?.current;
        const active = document.activeElement;
        // Headless UI may already restore focus before this animation callback.
        // Preserve any visible control the user has reached since then.
        if (!(active instanceof HTMLElement) || active === document.body || active.closest("[inert]") || !active.getClientRects().length) {
          target?.focus({ preventScroll: true });
        }
        previousFocus.current = null;
      }}
    >
      <div className="sr-only">
        <AnimatedModalTitle>{title}</AnimatedModalTitle>
        <AnimatedModalDescription>{description}</AnimatedModalDescription>
      </div>
      <Command ref={commandRef} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3">
        {children}
      </Command>
    </AnimatedModal>
  );
}

function CommandInput({
  className,
  wrapperClassName,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input> & {
  wrapperClassName?: string;
}) {
  return (
    <div
      data-slot="command-input-wrapper"
      className={cn(
        "flex h-9 items-center gap-2 rounded-full border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring",
        wrapperClassName,
      )}
    >
      <HugeiconsIcon
        icon={Search01Icon}
        aria-hidden="true"
        size={16}
        className="shrink-0 text-muted-foreground"
      />
      <CommandPrimitive.Input
        data-autofocus
        data-slot="command-input"
        className={cn(
          "flex h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("px-3 py-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex h-9 cursor-default items-center gap-2 rounded-full px-3 text-sm outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-muted/70 data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
