"use client"

import { forwardRef, useId } from "react"
import { Check } from "lucide-react"
import { Input as ArcInput } from "@/components/arc/input/input"
import type { InputHTMLAttributes, ReactNode } from "react"
import { cn } from "@/lib/utils"
export type InputClassNames = Partial<
  Record<
    | "root"
    | "label"
    | "field"
    | "input"
    | "leftIcon"
    | "rightIcon"
    | "successIcon"
    | "errorMessage",
    string
  >
>
export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange"
> {
  value?: string
  defaultValue?: string
  onChange?: (value: string) => void
  label?: string
  error?: string | boolean
  reserveErrorLine?: boolean
  success?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
  classNames?: InputClassNames
}

/** Arc field with the app's existing value callback, icons and validation contract. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    value,
    defaultValue,
    onChange,
    error,
    reserveErrorLine,
    success,
    leftIcon,
    rightIcon,
    className,
    classNames,
    id,
    ...props
  },
  ref
) {
  const generatedId = useId()
  const controlId = id ?? generatedId
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        className,
        classNames?.root
      )}
    >
      {label ? (
        <label
          htmlFor={controlId}
          className={cn("text-sm font-medium", classNames?.label)}
        >
          {label}
        </label>
      ) : null}
      <div className={cn("relative", classNames?.field)}>
        <ArcInput
          {...props}
          ref={ref}
          id={controlId}
          data-slot="input"
          value={value}
          defaultValue={defaultValue}
          onChange={(event) => onChange?.(event.target.value)}
          error={typeof error === "string" ? error : undefined}
          aria-invalid={error ? true : props["aria-invalid"]}
          className={cn(
            "h-9 rounded-xl bg-background",
            leftIcon && "pl-10",
            (rightIcon || success) && "pr-10",
            classNames?.input
          )}
        />
        {leftIcon ? (
          <span
            className={cn(
              "pointer-events-none absolute top-4.5 left-3 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:size-4",
              classNames?.leftIcon
            )}
          >
            {leftIcon}
          </span>
        ) : null}
        {success ? (
          <Check
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-4.5 right-3 size-4 -translate-y-1/2 text-primary",
              classNames?.successIcon
            )}
          />
        ) : rightIcon ? (
          <span
            className={cn(
              "absolute top-4.5 right-2 flex -translate-y-1/2 items-center text-muted-foreground",
              classNames?.rightIcon
            )}
          >
            {rightIcon}
          </span>
        ) : null}
      </div>
      {reserveErrorLine && typeof error !== "string" ? (
        <span aria-hidden="true" className="min-h-5" />
      ) : null}
    </div>
  )
})
