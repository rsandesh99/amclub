import {
  Building2,
  Calculator,
  Code,
  FileText,
  Landmark,
  Megaphone,
  Scale,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { CategorySlug } from '@amclub/shared'

/** Wizard category order + lucide glyphs, verbatim from the handoff spec. */
export const GATEWAY_CATEGORIES: { slug: CategorySlug; icon: LucideIcon }[] = [
  { slug: 'tax-accounting', icon: Calculator },
  { slug: 'company-registrations', icon: Building2 },
  { slug: 'legal', icon: Scale },
  { slug: 'hr-staffing', icon: Users },
  { slug: 'finance-facilitation', icon: Landmark },
  { slug: 'digital-marketing', icon: Megaphone },
  { slug: 'web-tech', icon: Code },
  { slug: 'government-licensing', icon: FileText },
]

/** slug → message-key suffix ("tax-accounting" → "tax_accounting"). */
export const catKey = (slug: string) => slug.replace(/-/g, '_')

export const BIZ_OPTIONS = ['manufacturing', 'trade', 'services'] as const
export const BAND_OPTIONS = ['1-9', '10-49', '50-249'] as const
export const EXP_OPTIONS = ['0-2', '3-9', '10+'] as const

/** message-key suffixes for value enums whose values aren't key-safe. */
export const BAND_KEY: Record<(typeof BAND_OPTIONS)[number], string> = {
  '1-9': 'band_1_9',
  '10-49': 'band_10_49',
  '50-249': 'band_50_249',
}
export const EXP_KEY: Record<(typeof EXP_OPTIONS)[number], string> = {
  '0-2': 'pexp_0_2',
  '3-9': 'pexp_3_9',
  '10+': 'pexp_10p',
}
