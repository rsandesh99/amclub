'use client'

import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface ListBuilderHandle {
  /** Adds any typed-but-not-added text and returns the resulting items. */
  commit: () => string[]
}

/** Mark a parent's Continue/Save control with this attribute: blurring the
 *  input onto it skips the blur-commit (the parent calls `commit()` itself),
 *  so the list doesn't grow — and shift the button — mid-tap. */
export const LIST_COMMIT_ATTR = 'data-list-commit'

/**
 * Add/remove list of short text items (scope, deliverables, requirements).
 * Typed-but-not-added text is never lost: it is committed on Enter, on blur,
 * and by the parent through the `commit()` handle before it validates.
 */
export const ListBuilder = forwardRef<ListBuilderHandle, {
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
  addLabel: string
}>(function ListBuilder({ items, onChange, placeholder, addLabel }, ref) {
  const t = useTranslations('common')
  const [draft, setDraft] = useState('')
  // Mirrors for commit(): the parent may call it before a re-render lands.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const itemsRef = useRef(items)
  itemsRef.current = items

  function add(): string[] {
    const v = draftRef.current.trim()
    if (!v) return itemsRef.current
    const next = [...itemsRef.current, v]
    itemsRef.current = next
    draftRef.current = ''
    onChange(next)
    setDraft('')
    return next
  }

  useImperativeHandle(ref, () => ({ commit: add }))

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-button border border-border bg-surface px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-words">{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="-my-2 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-button text-foreground-secondary hover:text-danger"
                aria-label={`${t('remove')}: ${item}`}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            const to = e.relatedTarget as HTMLElement | null
            if (to?.closest(`[${LIST_COMMIT_ATTR}]`)) return
            add()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="secondary" onClick={() => add()} className="shrink-0">
          <Plus className="h-4 w-4" /> {addLabel}
        </Button>
      </div>
    </div>
  )
})
