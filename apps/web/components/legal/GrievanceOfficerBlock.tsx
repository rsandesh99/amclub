import { getTranslations } from 'next-intl/server'
import { Mail, MapPin, Phone, UserRound } from 'lucide-react'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, whatsappHref } from '@/lib/legal/grievance'

/**
 * The statutory Grievance Officer block (name, designation, address, phone,
 * email + the 24 h / 15 d commitments). Single component, rendered on
 * /grievance and inside /terms — an address change is one edit in
 * lib/legal/grievance.ts. Server component (labels via next-intl).
 */
export async function GrievanceOfficerBlock({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations('grievance')
  const o = GRIEVANCE_OFFICER

  return (
    <section
      aria-labelledby="grievance-officer-heading"
      className={`rounded-card border border-border bg-surface ${compact ? 'p-4' : 'p-5 sm:p-6'}`}
    >
      <h2 id="grievance-officer-heading" className={`font-semibold text-foreground ${compact ? 'text-base' : 'text-lg'}`}>
        {t('officer_heading')}
      </h2>
      <address className="mt-3 flex flex-col gap-2 not-italic text-[15px] leading-relaxed text-foreground">
        <span className="flex items-start gap-2">
          <UserRound className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            <span className="font-medium">{o.name}</span>, {o.designation}
            <br />
            <span className="text-foreground-secondary">{o.organisation}</span>
          </span>
        </span>
        <span className="flex items-start gap-2">
          <MapPin className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            {o.addressLines.map((line, i) => (
              <span key={i}>
                {line}
                {i < o.addressLines.length - 1 && <br />}
              </span>
            ))}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <Phone className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <a href={`tel:${o.phoneE164}`} className="hover:text-primary hover:underline">{o.phone}</a>
          <span className="text-foreground-secondary">·</span>
          <a href={whatsappHref(o.phoneE164)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {t('whatsapp')}
          </a>
        </span>
        <span className="flex items-center gap-2">
          <Mail className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <a href={`mailto:${o.email}`} className="hover:text-primary hover:underline">{o.email}</a>
        </span>
      </address>
      <p className="mt-4 text-sm leading-relaxed text-foreground-secondary">
        {t('commitments', { ackHours: GRIEVANCE_SLA.acknowledgeHours, resolveDays: GRIEVANCE_SLA.resolveDays })}
      </p>
    </section>
  )
}
