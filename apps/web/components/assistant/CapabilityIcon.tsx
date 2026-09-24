import { Camera, Columns3, FileText, Gauge, Languages, LifeBuoy, ListChecks, MailCheck, MessageCircle, Mic, NotebookPen, Users } from 'lucide-react'
import type { AssistantCapability } from '@/lib/agent/capabilities'

const ICONS = {
  mic: Mic,
  file: FileText,
  check: ListChecks,
  columns: Columns3,
  gauge: Gauge,
  mail: MailCheck,
  help: LifeBuoy,
  whatsapp: MessageCircle,
  users: Users,
  camera: Camera,
  notebook: NotebookPen,
  languages: Languages,
} as const

export function CapabilityIcon({ icon, className }: { icon: AssistantCapability['icon']; className?: string }) {
  const Icon = ICONS[icon]
  return <Icon className={className} strokeWidth={1.75} aria-hidden />
}
