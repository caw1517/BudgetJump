import { useRef } from 'react'

type DatePickerInputProps = {
  value: string
  onChange: (value: string) => void
  className?: string
  disabled?: boolean
  required?: boolean
  min?: string
  max?: string
  id?: string
  name?: string
  'aria-label'?: string
}

export function DatePickerInput({
  value,
  onChange,
  className,
  disabled,
  required,
  min,
  max,
  id,
  name,
  'aria-label': ariaLabel,
}: DatePickerInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        min={min}
        max={max}
        id={id}
        name={name}
        aria-label={ariaLabel}
        className={[className ?? '', 'pr-12'].join(' ').trim()}
      />
      <button
        type="button"
        onClick={() => {
          const input = inputRef.current
          if (!input || disabled) return
          if (typeof input.showPicker === 'function') {
            input.showPicker()
            return
          }
          input.focus()
          input.click()
        }}
        disabled={disabled}
        aria-label={ariaLabel ? `Open ${ariaLabel} picker` : 'Open date picker'}
        className="absolute right-2 top-1/2 inline-flex h-8 -translate-y-1/2 items-center justify-center rounded-md border border-zinc-300 bg-white px-2 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        Pick
      </button>
    </div>
  )
}
