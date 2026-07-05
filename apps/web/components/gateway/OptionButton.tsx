'use client'

import { Check } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Marigold selection ring from the spec (3px, 35% accent). */
const PICKED_RING = '0 0 0 3px color-mix(in srgb, var(--accent) 35%, transparent)'

function Tick({ size, className }: { size: number; className?: string }) {
  return (
    <span
      className={cn(
        'gw-tick-pop inline-flex shrink-0 items-center justify-center rounded-chip bg-accent text-[#3A2A00]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Check strokeWidth={3} style={{ width: size * 0.58, height: size * 0.58 }} aria-hidden />
    </span>
  )
}

interface OptionButtonProps {
  /** row = label+sub list · row-plain = label only · need = buyer category
   *  tile · category = partner category tile · state = centered state cell */
  variant: 'row' | 'row-plain' | 'need' | 'category' | 'state'
  label: string
  sub?: string
  icon?: LucideIcon
  picked: boolean
  onClick: () => void
}

/**
 * One selectable wizard option. Picked → marigold border + soft ring + tick
 * pop (gwTickPop, 150ms bounce); hover lifts 2px; press settles to 0.98.
 */
export function OptionButton({ variant, label, sub, icon: Icon, picked, onClick }: OptionButtonProps) {
  const base =
    'relative cursor-pointer bg-white text-left font-sans transition-[border-color,box-shadow,transform] duration-150 ease-out ' +
    'motion-safe:hover:-translate-y-0.5 motion-safe:active:scale-[0.98] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ' +
    'border-[1.5px] ' +
    (picked ? 'border-accent' : 'border-border')
  const style = { boxShadow: picked ? PICKED_RING : 'var(--shadow-resting)' }

  if (variant === 'row' || variant === 'row-plain') {
    return (
      <button type="button" onClick={onClick} aria-pressed={picked} style={style}
        className={cn(base, 'flex min-h-16 w-full items-center gap-3.5 rounded-[14px] px-4 py-3.5')}>
        {variant === 'row' ? (
          <span className="flex flex-1 flex-col gap-0.5">
            <span className="text-[17px] font-bold text-foreground">{label}</span>
            {sub && <span className="text-[13.5px] leading-[1.4] text-foreground-secondary">{sub}</span>}
          </span>
        ) : (
          <span className="flex-1 text-[17px] font-bold text-foreground">{label}</span>
        )}
        {picked && <Tick size={26} />}
      </button>
    )
  }

  if (variant === 'need') {
    return (
      <button type="button" onClick={onClick} aria-pressed={picked} style={style}
        className={cn(base, 'flex min-h-[88px] flex-col items-start gap-[7px] rounded-[14px] px-3.5 py-3')}>
        {Icon && (
          <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </span>
        )}
        <span className="text-[14.5px] font-semibold leading-tight text-foreground [text-wrap:pretty]">{label}</span>
        {sub && <span className="text-[11.5px] leading-[1.3] text-foreground-secondary">{sub}</span>}
        {picked && <Tick size={24} className="absolute right-2.5 top-2.5" />}
      </button>
    )
  }

  if (variant === 'category') {
    return (
      <button type="button" onClick={onClick} aria-pressed={picked} style={style}
        className={cn(base, 'flex min-h-16 items-center gap-2.5 rounded-[14px] p-3')}>
        {Icon && (
          <span className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-primary-soft text-primary">
            <Icon className="h-[18px] w-[18px]" aria-hidden />
          </span>
        )}
        <span className="flex-1 text-[14.5px] font-semibold leading-tight text-foreground [text-wrap:pretty]">{label}</span>
        {picked && <Tick size={22} className="absolute right-2 top-2" />}
      </button>
    )
  }

  // state
  return (
    <button type="button" onClick={onClick} aria-pressed={picked} style={style}
      className={cn(base, 'flex min-h-14 items-center justify-center rounded-xl px-2 py-3 text-center text-[15px] font-semibold text-foreground')}>
      {label}
      {picked && <Tick size={22} className="absolute right-1.5 top-1.5" />}
    </button>
  )
}
