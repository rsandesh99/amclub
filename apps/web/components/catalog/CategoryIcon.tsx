import {
  Building2, Calculator, Scale, Users, Landmark, Megaphone, Code2,
  FileBadge, Banknote, Monitor, TrendingUp, Briefcase, type LucideIcon,
} from 'lucide-react'

// Map the seed/category `icon` slugs → lucide components.
const ICONS: Record<string, LucideIcon> = {
  'building-2': Building2,
  calculator: Calculator,
  scale: Scale,
  users: Users,
  landmark: Landmark,
  banknote: Banknote,
  megaphone: Megaphone,
  'trending-up': TrendingUp,
  'code-2': Code2,
  monitor: Monitor,
  'file-badge': FileBadge,
}

export function CategoryIcon({
  icon,
  className,
}: {
  icon: string | null | undefined
  className?: string
}) {
  const Icon = (icon && ICONS[icon]) || Briefcase
  return <Icon className={className} aria-hidden />
}
