"use client"

import { useReducedMotion } from "motion/react"
import {
  type ChangeEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { cn } from "@/lib/utils"
import {
  AgentChatComposer,
  type AgentChatComposerHandle,
  type ComposerValue,
} from "./composer"
import { DEFAULT_MODELS, DEFAULT_SKILLS } from "./constants"
import { CreditsAttachmentTray } from "./credits-attachment-tray"
import { CreditsImagePreview } from "./credits-image-preview"
import { CreditsToolbar } from "./credits-toolbar"
import { CreditsTopLayer } from "./credits-top-layer"
import { useControllableArray, useControllableString } from "./hooks"
import type {
  AgentChatAttachment,
  AgentChatInputOption,
  AgentChatInputStatus,
  AgentChatSkill,
} from "./types"
import { useAttachmentPreviewUrls } from "./use-attachment-preview-urls"
import { useSkillCommand } from "./use-skill-command"

export type AgentChatCreditsProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  onSubmit?: (
    value: string,
    attachments: readonly AgentChatAttachment[],
    skillIds: readonly string[],
    model: string
  ) => void
  onStop?: () => void
  onFilesSelected?: (files: File[]) => void
  attachments?: readonly AgentChatAttachment[]
  defaultAttachments?: readonly AgentChatAttachment[]
  onAttachmentsChange?: (attachments: AgentChatAttachment[]) => void
  acceptedFileTypes?: string
  skills?: readonly AgentChatSkill[]
  models?: readonly AgentChatInputOption[]
  model?: string
  defaultModel?: string
  onModelChange?: (model: string) => void
  skillIds?: readonly string[]
  defaultSkillIds?: readonly string[]
  onSkillIdsChange?: (skillIds: string[]) => void
  onVoiceClick?: () => void
  searchEnabled?: boolean
  defaultSearchEnabled?: boolean
  onSearchEnabledChange?: (enabled: boolean) => void
  onUpgradeClick?: () => void
  onDismissClick?: () => void
  creditsRemaining?: number
  status?: AgentChatInputStatus
  placeholder?: string
  disabled?: boolean
  className?: string
  compact?: boolean
  modelLocked?: boolean
  sendDisabled?: boolean
  stopping?: boolean
}

export function AgentChatCredits({
  value,
  defaultValue = "",
  onValueChange,
  onSubmit,
  onStop,
  onFilesSelected,
  attachments,
  defaultAttachments = [],
  onAttachmentsChange,
  acceptedFileTypes,
  skills = DEFAULT_SKILLS,
  models = DEFAULT_MODELS,
  model,
  defaultModel = models[0]?.id ?? "",
  onModelChange,
  skillIds,
  defaultSkillIds = [],
  onSkillIdsChange,
  onVoiceClick,
  searchEnabled,
  defaultSearchEnabled = false,
  onSearchEnabledChange,
  onUpgradeClick,
  onDismissClick,
  creditsRemaining = 490,
  status = "ready",
  placeholder = "What do you want to do today?",
  disabled = false,
  className,
  compact = false,
  modelLocked = false,
  sendDisabled = false,
  stopping = false,
}: AgentChatCreditsProps) {
  const reduce = useReducedMotion()
  const composerRef = useRef<AgentChatComposerHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(value ?? defaultValue)
  const [internalSearchEnabled, setInternalSearchEnabled] =
    useState(defaultSearchEnabled)
  const [internalAttachments, setInternalAttachments] = useState<
    AgentChatAttachment[]
  >([...defaultAttachments])
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(
    null
  )
  const [selectedSkillIds, setSelectedSkillIds] = useControllableArray<string>({
    value: skillIds,
    defaultValue: defaultSkillIds,
    onChange: onSkillIdsChange,
  })
  const [selectedModel, setSelectedModel] = useControllableString({
    value: model,
    defaultValue: defaultModel,
    onChange: onModelChange,
  })

  useLayoutEffect(() => {
    if (value !== undefined) composerRef.current?.setText(value)
  }, [value])
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [])
  useLayoutEffect(() => {
    composerRef.current?.focus()
  }, [])
  const currentAttachments = attachments ?? internalAttachments
  const previewUrls = useAttachmentPreviewUrls(currentAttachments)
  const skillCommand = useSkillCommand({ skills, composerRef })
  const isSearchEnabled = searchEnabled ?? internalSearchEnabled
  const previewAttachment = previewAttachmentId
    ? currentAttachments.find((item) => item.id === previewAttachmentId)
    : undefined
  const previewUrl = previewAttachmentId
    ? previewUrls[previewAttachmentId]
    : undefined
  const busy = status === "submitted" || status === "streaming"
  const canSubmit =
    !disabled &&
    !sendDisabled &&
    !busy &&
    ((value ?? text).trim().length > 0 || currentAttachments.length > 0)

  const closePreview = useCallback(
    () => setPreviewAttachmentId(null),
    [setPreviewAttachmentId]
  )

  function handleComposerChange(next: ComposerValue) {
    setText(next.text)
    onValueChange?.(next.text)
    setSelectedSkillIds(next.skillIds)
  }

  function submit() {
    if (!canSubmit) return
    const composed = composerRef.current?.serialize() ?? {
      text,
      skillIds: [...selectedSkillIds],
    }
    onSubmit?.(
      composed.text.trim(),
      currentAttachments,
      composed.skillIds,
      selectedModel
    )
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) {
      const next = [
        ...currentAttachments,
        ...files.map((file) => ({
          id: `${file.name}-${file.lastModified}-${file.size}-${crypto.randomUUID()}`,
          name: file.name,
          type: file.type,
          size: file.size,
          file,
        })),
      ]
      if (attachments === undefined) setInternalAttachments(next)
      onAttachmentsChange?.(next)
      onFilesSelected?.(files)
    }
    event.target.value = ""
  }

  function removeAttachment(id: string) {
    const next = currentAttachments.filter((item) => item.id !== id)
    if (attachments === undefined) setInternalAttachments(next)
    onAttachmentsChange?.(next)
  }

  function setSearch(next: boolean) {
    if (searchEnabled === undefined) setInternalSearchEnabled(next)
    onSearchEnabledChange?.(next)
  }

  return (
    <div
      className={cn(
        "glass-panel relative w-full max-w-3xl p-[3px] transition-[border-radius] duration-200",
        skillCommand.visible
          ? "rounded-t-none rounded-b-[1.25rem]"
          : "rounded-[1.25rem]",
        className
      )}
    >
      <CreditsTopLayer
        compact={compact}
        creditsRemaining={creditsRemaining}
        skillsVisible={skillCommand.visible}
        skills={skillCommand.options}
        selectedSkillIds={selectedSkillIds}
        activeIndex={skillCommand.activeIndex}
        reduce={reduce}
        onActiveIndexChange={skillCommand.setActiveIndex}
        onDismiss={onDismissClick}
        onSelect={skillCommand.select}
        onUpgrade={onUpgradeClick}
      />

      <div className="composer-field rounded-[1.1rem] px-2 pt-1.5 pb-2">
        <AgentChatComposer
          ref={composerRef}
          skills={skills}
          defaultValue={value ?? defaultValue}
          placeholder={placeholder}
          disabled={disabled}
          minRows={compact ? 1 : 2}
          maxRows={6}
          onChange={handleComposerChange}
          onSlashQueryChange={skillCommand.onQueryChange}
          onNavKeyDown={skillCommand.onNavKeyDown}
          onSubmit={submit}
          className={cn(
            "px-2.5 pb-2 !text-base leading-6 sm:px-3",
            compact
              ? "min-h-10 pt-1.5 sm:pt-1.5"
              : "min-h-[4.5rem] pt-2 sm:pt-2"
          )}
        />
        <CreditsToolbar
          busy={busy}
          canSubmit={canSubmit}
          disabled={disabled}
          reduce={reduce}
          models={models}
          selectedModel={selectedModel}
          searchEnabled={isSearchEnabled}
          onAttach={openFilePicker}
          onSearchChange={onSearchEnabledChange ? setSearch : undefined}
          onModelChange={setSelectedModel}
          modelLocked={modelLocked}
          stopping={stopping}
          onStop={onStop}
          onSubmit={submit}
          onVoice={onVoiceClick}
        />
      </div>

      <CreditsAttachmentTray
        attachments={currentAttachments}
        previewUrls={previewUrls}
        reduce={reduce}
        onPreview={setPreviewAttachmentId}
        onRemove={removeAttachment}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={acceptedFileTypes}
        onChange={handleFiles}
      />

      <CreditsImagePreview
        attachment={previewAttachment}
        src={previewUrl}
        onClose={closePreview}
      />
    </div>
  )
}
