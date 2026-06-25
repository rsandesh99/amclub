'use client'

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** Add/remove list of short text items (scope, deliverables, requirements). */
export function ListBuilder({
  items,
  onChange,
  placeholder,
  addLabel,
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
  addLabel: string
}) {
  const [draft, setDraft] = useState('')

  function add() {
    const v = draft.trim()
    if (!v) return
    onChange([...items, v])
    setDraft('')
  }

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map((item, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-2 rounded-button border border-gray-200 bg-surface px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-words">{item}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                className="shrink-0 text-foreground-secondary hover:text-danger"
                aria-label="Remove"
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
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="secondary" onClick={add} className="shrink-0">
          <Plus className="h-4 w-4" /> {addLabel}
        </Button>
      </div>
    </div>
  )
}
