import { getTranslations } from 'next-intl/server'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Link } from '@/i18n/navigation'

/**
 * On the profile page: one row that leads to the assistant home, where the
 * assistant is explained in plain words and switched on or off. (The raw scope
 * list that used to live here is gone.)
 */
export async function AssistantProfileLink({ href }: { href: '/app/ai' | '/partner/ai' }) {
  const t = await getTranslations('assistant_home')
  return (
    <Link href={href} className="flex items-center gap-3 rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40 hover:bg-primary/5" data-testid="assistant-profile-link">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"><Sparkles className="h-5 w-5" aria-hidden /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">{t('profile_link_title')}</span>
        <span className="block text-xs text-foreground-secondary">{t('profile_link_body')}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden />
    </Link>
  )
}
