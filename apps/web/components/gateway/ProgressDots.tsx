'use client'

/**
 * 4-dot wizard progress: current step stretches to a 22px marigold pill,
 * completed dots are brand green, upcoming dots hairline gray; width and
 * colour morph over 250ms ease-out (spec).
 */
export function ProgressDots({ step }: { step: number }) {
  return (
    <div className="flex gap-[7px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="h-2 rounded-chip transition-[background,width] duration-[250ms] ease-out"
          style={{
            width: i === step ? 22 : 8,
            background:
              i < step ? 'var(--primary)' : i === step ? 'var(--accent)' : 'var(--border)',
          }}
        />
      ))}
    </div>
  )
}
