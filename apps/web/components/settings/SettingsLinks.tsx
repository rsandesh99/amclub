import { getTranslations } from 'next-intl/server'
import { BellRing, CircleHelp, Lock, ShieldCheck } from 'lucide-react'
import { GroupedRow, GroupedSection } from '@/components/ui-v3/GroupedList'

/**
 * The profile page's settings rows (buyer and provider): notification
 * settings, privacy requests, help and the WhatsApp safety page. The WhatsApp
 * switches sit on the profile page itself (#whatsapp).
 */
export async function SettingsLinks({ persona }: { persona: 'buyer' | 'provider' }) {
  const t = await getTranslations('profile')
  const base = persona === 'provider' ? '/partner' : '/app'
  return (
    <div data-testid="settings-links">
      <GroupedSection header={t('settings_section')}>
        <GroupedRow href={`${base}/settings/notifications`} leading={<BellRing className="h-5 w-5" aria-hidden />} title={t('settings_notifications')} subtitle={t('settings_notifications_sub')} />
        <GroupedRow href={`${base}/privacy`} leading={<Lock className="h-5 w-5" aria-hidden />} title={t('settings_privacy')} subtitle={t('settings_privacy_sub')} />
        <GroupedRow href="/help" leading={<CircleHelp className="h-5 w-5" aria-hidden />} title={t('settings_help')} />
        <GroupedRow href="/help/whatsapp-safety" leading={<ShieldCheck className="h-5 w-5" aria-hidden />} title={t('settings_safety')} />
      </GroupedSection>
    </div>
  )
}
