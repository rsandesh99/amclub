import { useEffect, useState } from 'react'
import { Linking, Modal, Text, TouchableOpacity, View } from 'react-native'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'

const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? ''
type LegalDoc = 'terms' | 'privacy' | 'provider_addendum'
const DOC_PATH: Record<LegalDoc, string> = { terms: '/terms', privacy: '/privacy', provider_addendum: '/provider-addendum' }

/**
 * Re-acceptance gate for existing users (Phase 2b, mobile). Mounted in the
 * authenticated (app) layout: asks /api/v1/legal/status; if any required
 * document is not accepted at its current version, shows a blocking modal
 * with the document links and one Accept button (writes terms_acceptances
 * with surface 'mobile').
 */
export function LegalGateModal() {
  const { t } = useI18n()
  const [required, setRequired] = useState<LegalDoc[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return
      const res = await fetch(`${API_URL}/api/v1/legal/status`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      }).catch(() => null)
      const d = res && res.ok ? ((await res.json().catch(() => null)) as { required?: LegalDoc[] } | null) : null
      if (active && d?.required?.length) setRequired(d.required)
    })()
    return () => {
      active = false
    }
  }, [])

  if (required.length === 0) return null

  async function accept() {
    setBusy(true)
    setError(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('no session')
      const res = await fetch(`${API_URL}/api/v1/legal/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ docs: required, surface: 'mobile' }),
      })
      if (!res.ok) throw new Error('accept failed')
      const d = (await res.json().catch(() => null)) as { required?: LegalDoc[] } | null
      setRequired(d?.required ?? [])
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View className="flex-1 items-center justify-end bg-black/50 p-4">
        <View className="w-full rounded-2xl bg-surface p-6">
          <Text className="text-xl font-bold text-foreground">{t('legal_gate.title')}</Text>
          <Text className="mt-2 text-sm leading-5 text-foreground-secondary">{t('legal_gate.body')}</Text>
          <View className="mt-4 gap-2">
            {required.map((doc) => (
              <TouchableOpacity
                key={doc}
                onPress={() => Linking.openURL(`${API_URL}${DOC_PATH[doc]}`)}
                className="rounded-xl border border-gray-200 px-3 py-3"
              >
                <Text className="text-sm font-medium text-primary underline">{t(`legal_gate.doc_${doc}`)}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {error && <Text className="mt-3 text-sm text-red-600">{t('legal_gate.error')}</Text>}
          <TouchableOpacity onPress={accept} disabled={busy} className={`mt-5 items-center rounded-xl py-4 ${busy ? 'bg-primary/60' : 'bg-primary'}`}>
            <Text className="text-base font-semibold text-white">{busy ? t('common.loading') : t('legal_gate.accept')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => supabase.auth.signOut()} className="mt-3 items-center">
            <Text className="text-xs text-foreground-secondary underline">{t('legal_gate.sign_out')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  )
}
