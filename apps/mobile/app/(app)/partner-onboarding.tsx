import { ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useCallback, useEffect, useRef, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import {
  CATEGORY_LIST,
  INDIAN_STATES,
  ONBOARDING_V3_STEPS,
  PROVIDER_LANGUAGES,
  PROVIDER_LEGAL_DOCS,
  autofilledFields,
  categoriesRequiringCredential,
  isValidGstin,
  pickLocale,
  statutoryOptionsForCategory,
  type GstinAutofill,
  type OnboardingV3Step,
} from '@amclub/shared'
import { useI18n } from '@/lib/i18n'
import { acceptLegalDocsMobile, saveOnboardingStep, submitProviderProfile, uploadCredentialDocument, verifyBankForOnboarding, verifyGstinForOnboarding } from '@/lib/api'
import { track } from '@/lib/analytics'
import { confirmHaptic } from '@/lib/haptics'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Sheet } from '@/components/ui/Sheet'

const DRAFT_KEY = 'amc_provider_wizard_v3'
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CATEGORIES = 5
const YEARS = ['0-2', '3-9', '10+'] as const

interface Draft {
  fullName: string
  gstin: string
  autofill: GstinAutofill | null
  legalName: string
  displayName: string
  stateCode: string
  city: string
  yearsExperience: '' | (typeof YEARS)[number]
  primaryCategory: string
  extraCategories: string[]
  languages: string[]
  credentialKinds: Record<string, string>
  credentialNumbers: Record<string, string>
  credentialUploads: Record<string, { url: string; name: string }>
  bankAccount: string
  bankIfsc: string
  bankHolder: string
  bankVerified: boolean
  bankHolderFromBank: string | null
}

const EMPTY: Draft = {
  fullName: '', gstin: '', autofill: null, legalName: '', displayName: '', stateCode: '', city: '', yearsExperience: '',
  primaryCategory: '', extraCategories: [], languages: ['en'],
  credentialKinds: {}, credentialNumbers: {}, credentialUploads: {},
  bankAccount: '', bankIfsc: '', bankHolder: '', bankVerified: false, bankHolderFromBank: null,
}

type WizardView = 'needs' | OnboardingV3Step | 'done'

/** When the current step was shown (analytics ms); written by the step effect, read only in handlers. */
let stepStartedAt = 0
const msSinceStep = (): number => Date.now() - stepStartedAt

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} testID={testID} className={`rounded-full border px-3 py-1.5 ${on ? 'border-primary bg-primary/10' : 'border-gray-200'}`}>
      <Text className={`text-xs ${on ? 'font-semibold text-primary' : 'text-foreground'}`}>{label}</Text>
    </TouchableOpacity>
  )
}

function Field({ label, value, onChange, placeholder, locked, lockedNote, keyboardType, autoCapitalize, secure }: { label: string; value: string; onChange?: (v: string) => void; placeholder?: string; locked?: boolean; lockedNote?: string; keyboardType?: 'default' | 'number-pad'; autoCapitalize?: 'none' | 'characters' | 'words'; secure?: boolean }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-medium text-foreground-secondary">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!locked}
        placeholder={placeholder}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'words'}
        secureTextEntry={secure}
        accessibilityLabel={label}
        className={`rounded-lg border border-gray-200 px-3 py-2.5 text-sm ${locked ? 'bg-muted text-foreground-secondary' : 'bg-background text-foreground'}`}
      />
      {locked && lockedNote ? <Text className="text-[11px] text-foreground-secondary">{lockedNote}</Text> : null}
    </View>
  )
}

/**
 * PRD Experience v3 E13 FR-13.4 (D-PRD3) — the E10 provider wizard as native
 * screens: What you'll need → Contact → Business (GSTIN first, autofilled
 * from GST records) → Credentials & bank (camera or file for documents) →
 * Review & submit. The same shared rules and the same routes as the web
 * (verify-gstin, credential-upload, verify-bank, legal/accept, POST
 * /profile/provider), each step saved on the server (onboarding-progress) so
 * a nudge reopens the same step on either surface. The bank account number is
 * never stored on the device.
 */
export default function PartnerOnboardingScreen() {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string }
  const params = useLocalSearchParams<{ step?: string }>()
  const initialStep = (ONBOARDING_V3_STEPS as readonly string[]).includes(params.step ?? '') ? (params.step as OnboardingV3Step) : null
  const [view, setView] = useState<WizardView>(initialStep ?? 'needs')
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'gstin' | 'bank' | 'upload' | 'submit' | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [statePicker, setStatePicker] = useState(false)
  const loaded = useRef(false)

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const categories = [draft.primaryCategory, ...draft.extraCategories.filter((c) => c !== draft.primaryCategory)].filter(Boolean)
  const credSlugs = categoriesRequiringCredential(categories)

  // Restore the device draft (TTL; the account number never comes back).
  useEffect(() => {
    void SecureStore.getItemAsync(DRAFT_KEY).then((raw) => {
      loaded.current = true
      if (!raw) return
      try {
        const env = JSON.parse(raw) as { savedAt?: number; draft?: Partial<Draft> }
        if (!env.savedAt || Date.now() - env.savedAt > DRAFT_TTL_MS) { void SecureStore.deleteItemAsync(DRAFT_KEY); return }
        setDraft((d) => ({ ...d, ...env.draft, bankAccount: '', bankVerified: false, bankHolderFromBank: null }))
        if (!initialStep) setView('contact')
      } catch { /* bad JSON: start fresh */ }
    }).catch(() => { loaded.current = true })
  }, [initialStep])
  useEffect(() => {
    if (!loaded.current) return
    const { bankAccount: _drop, autofill: _big, ...keep } = draft
    void SecureStore.setItemAsync(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), draft: keep })).catch(() => undefined)
  }, [draft])

  // FR-10.4 — step analytics + the server-side progress row the stall nudge reads.
  useEffect(() => {
    if (view === 'needs' || view === 'done') return
    stepStartedAt = Date.now()
    track('onboarding_step_viewed', { platform: 'android', step: view, category: draft.primaryCategory || null })
    void saveOnboardingStep(view, draft.primaryCategory || undefined)
  }, [view]) // eslint-disable-line react-hooks/exhaustive-deps -- once per step change

  const go = useCallback((to: WizardView) => {
    if (view !== 'needs' && view !== 'done' && ONBOARDING_V3_STEPS.indexOf(to as OnboardingV3Step) > ONBOARDING_V3_STEPS.indexOf(view)) {
      track('onboarding_step_completed', { platform: 'android', step: view, ms: msSinceStep() })
    }
    setError('')
    setView(to)
  }, [view])

  async function verifyGstin() {
    const gstin = draft.gstin.trim().toUpperCase()
    if (!isValidGstin(gstin)) { setError(t('onboarding_v3.gstin_invalid')); return }
    setBusy('gstin'); setError('')
    const r = await verifyGstinForOnboarding(gstin)
    setBusy(null)
    const a = r.data?.autofill
    if (!r.ok || !r.data?.verified || !a) { setError(t('onboarding_v3.gstin_failed')); update({ autofill: null }); return }
    update({ gstin, autofill: a, legalName: a.legalName ?? draft.legalName, displayName: draft.displayName || a.tradeName || a.legalName || '', stateCode: a.state ?? draft.stateCode })
    if (a.active) track('onboarding_gstin_autofilled', { platform: 'android', fields: autofilledFields(a).length })
  }

  async function uploadFor(slug: string, source: 'camera' | 'file') {
    let file: { uri: string; name: string; mimeType: string } | null = null
    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync()
      if (!perm.granted) { setError(t('onboarding_v3.camera_denied')); return }
      const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 })
      const a = shot.canceled ? null : shot.assets?.[0]
      if (a) file = { uri: a.uri, name: a.fileName ?? `${slug}.jpg`, mimeType: a.mimeType ?? 'image/jpeg' }
    } else {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: ['application/pdf', 'image/*'] })
      const a = picked.canceled ? null : picked.assets?.[0]
      if (a) file = { uri: a.uri, name: a.name, mimeType: a.mimeType ?? 'application/octet-stream' }
    }
    if (!file) return
    setBusy('upload'); setError('')
    const r = await uploadCredentialDocument(slug, file)
    setBusy(null)
    if (!r.ok || !r.url) { setError(t('onboarding_v3.upload_failed')); return }
    update({ credentialUploads: { ...draft.credentialUploads, [slug]: { url: r.url, name: file.name } } })
  }

  async function verifyBank() {
    const account = draft.bankAccount.trim()
    const ifsc = draft.bankIfsc.trim().toUpperCase()
    if (!/^\d{9,18}$/.test(account)) { setError(t('onboarding_v3.err_bank_account')); return }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) { setError(t('onboarding_v3.err_bank_ifsc')); return }
    const holder = draft.bankHolder.trim() || draft.legalName
    setBusy('bank'); setError('')
    const r = await verifyBankForOnboarding({ accountNumber: account, ifsc, holderName: holder })
    setBusy(null)
    if (!r.ok || !r.data?.verified) { setError(t('onboarding_v3.bank_failed')); return }
    update({ bankIfsc: ifsc, bankHolder: r.data.accountHolderName || holder, bankHolderFromBank: r.data.accountHolderName ?? null, bankVerified: true })
  }

  const contactOk = draft.fullName.trim().length >= 2
  const gstinOk = !!draft.autofill?.verified && draft.autofill.active && draft.gstin.length === 15
  const businessOk = gstinOk && draft.legalName.trim().length >= 2 && draft.displayName.trim().length >= 2 && !!draft.stateCode && !!draft.primaryCategory
  const credsOk = credSlugs.every((s) => !!draft.credentialKinds[s] && !!draft.credentialNumbers[s]?.trim() && !!draft.credentialUploads[s])
  const bankOk = draft.bankVerified && !!draft.bankAccount.trim()

  async function submit() {
    if (!accepted) { setError(t('onboarding_v3.accept_required')); return }
    if (!bankOk) { setError(t('onboarding_v3.bank_required')); go('credentials_bank'); return }
    setBusy('submit'); setError('')
    confirmHaptic()
    const legal = await acceptLegalDocsMobile([...PROVIDER_LEGAL_DOCS], locale ?? 'en')
    if (!legal.ok) { setBusy(null); setError(t('onboarding_v3.submit_failed')); return }
    const r = await submitProviderProfile({
      fullName: draft.fullName.trim(),
      preferredLocale: locale ?? 'en',
      legalName: draft.legalName.trim(),
      displayName: draft.displayName.trim(),
      ...(draft.yearsExperience ? { yearsExperience: draft.yearsExperience } : {}),
      gstin: draft.gstin,
      categorySlugs: categories,
      state: draft.stateCode,
      ...(draft.city.trim() ? { city: draft.city.trim() } : {}),
      languages: draft.languages,
      bankIfsc: draft.bankIfsc,
      bankAccount: draft.bankAccount.trim(),
      bankHolder: draft.bankHolder.trim() || draft.legalName.trim(),
      bankVerified: draft.bankVerified,
      credentialUploads: Object.fromEntries(credSlugs.map((s) => [s, { ...draft.credentialUploads[s], kind: draft.credentialKinds[s], number: draft.credentialNumbers[s]?.trim() }])),
    })
    setBusy(null)
    if (!r.ok) { setError(typeof r.data?.error === 'string' ? r.data.error : t('onboarding_v3.submit_failed')); return }
    track('onboarding_step_completed', { platform: 'android', step: 'review', ms: msSinceStep() })
    track('onboarding_submitted', { platform: 'android', category: draft.primaryCategory, path: 'gstin' })
    void SecureStore.deleteItemAsync(DRAFT_KEY).catch(() => undefined)
    setView('done')
  }

  const idx = ONBOARDING_V3_STEPS.indexOf(view as OnboardingV3Step)
  const catName = (slug: string) => { const c = CATEGORY_LIST.find((x) => x.slug === slug); return c ? pickLocale(c.name_i18n, locale ?? 'en') : slug }
  const stateName = (code: string) => INDIAN_STATES.find((s) => s.value === code)?.label ?? code
  const primary = (label: string, onPress: () => void, enabled: boolean, testID?: string) => (
    <TouchableOpacity onPress={onPress} disabled={!enabled || busy !== null} accessibilityRole="button" testID={testID} className={`items-center rounded-lg py-3 ${enabled && busy === null ? 'bg-primary' : 'bg-primary/40'}`}>
      {busy === 'submit' && testID === 'wizard-submit' ? <ActivityIndicator color="#fff" /> : <Text className="text-sm font-semibold text-white">{label}</Text>}
    </TouchableOpacity>
  )

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      <ScreenHeader title={t('onboarding_v3.title')} />
      {idx >= 0 && (
        <View className="flex-row gap-1 px-4 pt-3" accessibilityLabel={t('onboarding_v3.step_of', { n: idx + 1, of: ONBOARDING_V3_STEPS.length })}>
          {ONBOARDING_V3_STEPS.map((s, i) => <View key={s} className={`h-1 flex-1 rounded-full ${i <= idx ? 'bg-primary' : 'bg-muted'}`} />)}
        </View>
      )}
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" keyboardShouldPersistTaps="handled" testID={`wizard-${view}`}>
        {view === 'needs' && (
          <>
            <Text className="text-xl font-bold text-foreground">{t('onboarding_v3.needs_title')}</Text>
            {['needs_gstin', 'needs_bank', 'needs_credential', 'needs_time'].map((k) => <Text key={k} className="text-sm text-foreground">• {t(`onboarding_v3.${k}`)}</Text>)}
            {primary(t('onboarding_v3.start'), () => go('contact'), true, 'wizard-start')}
          </>
        )}

        {view === 'contact' && (
          <>
            <Text className="text-lg font-bold text-foreground">{t('onboarding_v3.step_contact')}</Text>
            <Field label={t('onboarding_v3.full_name')} value={draft.fullName} onChange={(v) => update({ fullName: v })} />
            {primary(t('onboarding_v3.continue'), () => go('business'), contactOk, 'wizard-next')}
          </>
        )}

        {view === 'business' && (
          <>
            <Text className="text-lg font-bold text-foreground">{t('onboarding_v3.step_business')}</Text>
            <Field label={t('onboarding_v3.gstin')} value={draft.gstin} onChange={(v) => update({ gstin: v.toUpperCase().slice(0, 15), autofill: null })} autoCapitalize="characters" placeholder="22AAAAA0000A1Z5" />
            <TouchableOpacity onPress={() => void verifyGstin()} disabled={busy !== null} className="items-center rounded-lg border border-gray-200 py-2.5" accessibilityRole="button" testID="wizard-verify-gstin">
              {busy === 'gstin' ? <ActivityIndicator color="#1B4D3E" /> : <Text className="text-sm font-semibold text-primary">{gstinOk ? t('onboarding_v3.gstin_verified') : t('onboarding_v3.verify_gstin')}</Text>}
            </TouchableOpacity>
            {draft.autofill && !draft.autofill.active ? <Text className="text-xs text-[#b45309]">{t('onboarding_v3.gstin_inactive')}</Text> : null}
            {draft.autofill?.stateMismatch ? <Text className="text-xs text-[#b45309]">{t('onboarding_v3.state_mismatch')}</Text> : null}
            <Field label={t('onboarding_v3.legal_name')} value={draft.legalName} locked={!!draft.autofill?.legalName} lockedNote={t('onboarding_v3.from_gst')} onChange={(v) => update({ legalName: v })} />
            <Field label={t('onboarding_v3.display_name')} value={draft.displayName} onChange={(v) => update({ displayName: v })} />
            <View className="gap-1">
              <Text className="text-xs font-medium text-foreground-secondary">{t('onboarding_v3.state')}</Text>
              <TouchableOpacity onPress={() => setStatePicker(true)} className="rounded-lg border border-gray-200 px-3 py-2.5" accessibilityRole="button" testID="wizard-state">
                <Text className="text-sm text-foreground">{draft.stateCode ? stateName(draft.stateCode) : t('onboarding_v3.pick_state')}</Text>
              </TouchableOpacity>
            </View>
            <Field label={t('onboarding_v3.city')} value={draft.city} onChange={(v) => update({ city: v })} />
            <Text className="text-xs font-medium text-foreground-secondary">{t('onboarding_v3.years')}</Text>
            <View className="flex-row flex-wrap gap-2">{YEARS.map((y) => <Chip key={y} label={t(`onboarding_v3.years_${y}`)} on={draft.yearsExperience === y} onPress={() => update({ yearsExperience: y })} />)}</View>
            <Text className="text-xs font-medium text-foreground-secondary">{t('onboarding_v3.primary_category')}</Text>
            <View className="flex-row flex-wrap gap-2">
              {CATEGORY_LIST.map((c) => <Chip key={c.slug} label={catName(c.slug)} on={draft.primaryCategory === c.slug} onPress={() => update({ primaryCategory: c.slug, extraCategories: draft.extraCategories.filter((x) => x !== c.slug) })} testID={`cat-${c.slug}`} />)}
            </View>
            {draft.primaryCategory ? (
              <>
                <Text className="text-xs font-medium text-foreground-secondary">{t('onboarding_v3.extra_categories', { max: MAX_CATEGORIES - 1 })}</Text>
                <View className="flex-row flex-wrap gap-2">
                  {CATEGORY_LIST.filter((c) => c.slug !== draft.primaryCategory).map((c) => {
                    const on = draft.extraCategories.includes(c.slug)
                    return <Chip key={c.slug} label={catName(c.slug)} on={on} onPress={() => update({ extraCategories: on ? draft.extraCategories.filter((x) => x !== c.slug) : draft.extraCategories.length >= MAX_CATEGORIES - 1 ? draft.extraCategories : [...draft.extraCategories, c.slug] })} />
                  })}
                </View>
              </>
            ) : null}
            <Text className="text-xs font-medium text-foreground-secondary">{t('onboarding_v3.languages')}</Text>
            <View className="flex-row flex-wrap gap-2">
              {PROVIDER_LANGUAGES.map((l) => {
                const on = draft.languages.includes(l)
                return <Chip key={l} label={t(`locale.${l}`)} on={on} onPress={() => update({ languages: on ? (draft.languages.length > 1 ? draft.languages.filter((x) => x !== l) : draft.languages) : [...draft.languages, l] })} />
              })}
            </View>
            {primary(t('onboarding_v3.continue'), () => go('credentials_bank'), businessOk, 'wizard-next')}
          </>
        )}

        {view === 'credentials_bank' && (
          <>
            <Text className="text-lg font-bold text-foreground">{t('onboarding_v3.step_credentials_bank')}</Text>
            {credSlugs.map((slug) => (
              <View key={slug} className="gap-2 rounded-xl border border-gray-200 bg-surface p-4" testID={`cred-${slug}`}>
                <Text className="text-sm font-semibold text-foreground">{t('onboarding_v3.credential_for', { category: catName(slug) })}</Text>
                <View className="flex-row flex-wrap gap-2">
                  {statutoryOptionsForCategory(slug).map((o) => <Chip key={o} label={t(`onboarding_v3.cred_${o}`)} on={draft.credentialKinds[slug] === o} onPress={() => update({ credentialKinds: { ...draft.credentialKinds, [slug]: o } })} />)}
                </View>
                <Field label={t('onboarding_v3.credential_number')} value={draft.credentialNumbers[slug] ?? ''} autoCapitalize="characters" onChange={(v) => update({ credentialNumbers: { ...draft.credentialNumbers, [slug]: v } })} />
                <View className="flex-row gap-2">
                  <TouchableOpacity onPress={() => void uploadFor(slug, 'camera')} disabled={busy !== null} className="flex-1 items-center rounded-lg border border-gray-200 py-2.5" accessibilityRole="button"><Text className="text-sm text-primary">{t('onboarding_v3.take_photo')}</Text></TouchableOpacity>
                  <TouchableOpacity onPress={() => void uploadFor(slug, 'file')} disabled={busy !== null} className="flex-1 items-center rounded-lg border border-gray-200 py-2.5" accessibilityRole="button"><Text className="text-sm text-primary">{t('onboarding_v3.choose_file')}</Text></TouchableOpacity>
                </View>
                {busy === 'upload' ? <ActivityIndicator color="#1B4D3E" /> : draft.credentialUploads[slug] ? <Text className="text-xs text-success">{t('onboarding_v3.uploaded', { name: draft.credentialUploads[slug]!.name })}</Text> : null}
              </View>
            ))}
            <View className="gap-2 rounded-xl border border-gray-200 bg-surface p-4">
              <Text className="text-sm font-semibold text-foreground">{t('onboarding_v3.bank_title')}</Text>
              <Field label={t('onboarding_v3.bank_account')} value={draft.bankAccount} keyboardType="number-pad" autoCapitalize="none" secure onChange={(v) => update({ bankAccount: v.replace(/\D/g, '').slice(0, 18), bankVerified: false })} />
              <Field label={t('onboarding_v3.bank_ifsc')} value={draft.bankIfsc} autoCapitalize="characters" onChange={(v) => update({ bankIfsc: v.toUpperCase().slice(0, 11), bankVerified: false })} />
              <Field label={t('onboarding_v3.bank_holder')} value={draft.bankHolder} locked={!!draft.bankHolderFromBank} lockedNote={t('onboarding_v3.from_bank')} onChange={(v) => update({ bankHolder: v })} />
              <TouchableOpacity onPress={() => void verifyBank()} disabled={busy !== null} className="items-center rounded-lg border border-gray-200 py-2.5" accessibilityRole="button" testID="wizard-verify-bank">
                {busy === 'bank' ? <ActivityIndicator color="#1B4D3E" /> : <Text className="text-sm font-semibold text-primary">{draft.bankVerified ? t('onboarding_v3.bank_verified') : t('onboarding_v3.verify_bank')}</Text>}
              </TouchableOpacity>
            </View>
            {primary(t('onboarding_v3.continue'), () => go('review'), credsOk && bankOk, 'wizard-next')}
          </>
        )}

        {view === 'review' && (
          <>
            <Text className="text-lg font-bold text-foreground">{t('onboarding_v3.step_review')}</Text>
            {([
              ['contact', [[t('onboarding_v3.full_name'), draft.fullName]]],
              ['business', [[t('onboarding_v3.gstin'), draft.gstin], [t('onboarding_v3.legal_name'), draft.legalName], [t('onboarding_v3.display_name'), draft.displayName], [t('onboarding_v3.state'), stateName(draft.stateCode)], [t('onboarding_v3.primary_category'), categories.map(catName).join(', ')]]],
              ['credentials_bank', [...credSlugs.map((s) => [t(`onboarding_v3.cred_${draft.credentialKinds[s] ?? 'ca'}`), draft.credentialNumbers[s] ?? '']), [t('onboarding_v3.bank_account'), draft.bankAccount ? `•••• ${draft.bankAccount.slice(-4)}` : ''], [t('onboarding_v3.bank_ifsc'), draft.bankIfsc]]],
            ] as [OnboardingV3Step, string[][]][]).map(([step, rows]) => (
              <View key={step} className="gap-1 rounded-xl border border-gray-200 bg-surface p-4">
                <View className="flex-row items-center justify-between">
                  <Text className="text-sm font-semibold text-foreground">{t(`onboarding_v3.step_${step}`)}</Text>
                  <TouchableOpacity onPress={() => go(step)} accessibilityRole="button"><Text className="text-sm text-primary">{t('onboarding_v3.edit')}</Text></TouchableOpacity>
                </View>
                {rows.map(([k, v]) => <Text key={k} className="text-xs text-foreground-secondary">{k}: <Text className="text-foreground">{v}</Text></Text>)}
              </View>
            ))}
            <TouchableOpacity onPress={() => setAccepted((a) => !a)} accessibilityRole="checkbox" accessibilityState={{ checked: accepted }} className="flex-row items-start gap-2" testID="wizard-accept">
              <Text className="text-base">{accepted ? '☑' : '☐'}</Text>
              <Text className="flex-1 text-sm text-foreground">{t('onboarding_v3.accept_terms')}</Text>
            </TouchableOpacity>
            {primary(t('onboarding_v3.submit'), () => void submit(), accepted, 'wizard-submit')}
          </>
        )}

        {view === 'done' && (
          <View className="items-center gap-3 py-8">
            <Text className="text-4xl">✅</Text>
            <Text className="text-center text-lg font-bold text-foreground">{t('onboarding_v3.done_title')}</Text>
            <Text className="text-center text-sm text-foreground-secondary">{t('onboarding_v3.done_body')}</Text>
            {primary(t('onboarding_v3.done_cta'), () => router.replace('/partner' as never), true)}
          </View>
        )}

        {error ? <Text accessibilityRole="alert" className="text-sm text-red-700">{error}</Text> : null}
      </ScrollView>

      <Sheet visible={statePicker} onClose={() => setStatePicker(false)} title={t('onboarding_v3.pick_state')} initialDetent="large" testID="state-sheet">
        <ScrollView>
          {INDIAN_STATES.map((s) => (
            <TouchableOpacity key={s.value} onPress={() => { update({ stateCode: s.value }); setStatePicker(false) }} className="border-b border-gray-100 py-3" accessibilityRole="button">
              <Text className={`text-sm ${draft.stateCode === s.value ? 'font-semibold text-primary' : 'text-foreground'}`}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </Sheet>
    </SafeAreaView>
  )
}
