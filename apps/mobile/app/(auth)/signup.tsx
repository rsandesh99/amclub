import {
  Alert, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { normalisePhone, isEmail, signInWithGoogle } from '@/lib/auth'

type Method = 'phone' | 'email'
type Step = 'auth' | 'otp' | 'profile'

const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? ''

export default function SignupScreen() {
  const { t } = useI18n()
  const [method, setMethod] = useState<Method>('phone')
  const [step, setStep] = useState<Step>('auth')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [fullName, setFullName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [loading, setLoading] = useState(false)
  // Phase 2b — explicit Terms + Privacy consent; blocks OTP/Google until ticked
  // and is written to terms_acceptances (surface 'mobile') before the profile
  // POST, which refuses without it.
  const [agreed, setAgreed] = useState(false)

  function requireConsent(): boolean {
    if (agreed) return true
    Alert.alert(t('errors.title'), t('errors.consent_required'))
    return false
  }

  async function sendOtp() {
    if (!requireConsent()) return
    setLoading(true)
    try {
      if (method === 'phone') {
        const normalised = normalisePhone(phone)
        if (normalised.length < 13) { Alert.alert(t('errors.title'), t('errors.invalid_phone')); return }
        const { error } = await supabase.auth.signInWithOtp({ phone: normalised, options: { shouldCreateUser: true } })
        if (error) { Alert.alert(t('common.error'), error.message); return }
      } else {
        if (!isEmail(email)) { Alert.alert(t('errors.title'), t('errors.invalid_email')); return }
        const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } })
        if (error) { Alert.alert(t('common.error'), error.message); return }
      }
      setStep('otp')
    } finally {
      setLoading(false)
    }
  }

  async function verifyOtp() {
    if (otp.length !== 6) { Alert.alert(t('errors.title'), t('errors.invalid_code')); return }
    setLoading(true)
    try {
      const { error } =
        method === 'phone'
          ? await supabase.auth.verifyOtp({ phone: normalisePhone(phone), token: otp, type: 'sms' })
          : await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: otp, type: 'email' })
      if (error) { Alert.alert(t('common.error'), error.message); return }
      setStep('profile')
    } finally {
      setLoading(false)
    }
  }

  async function google() {
    if (!requireConsent()) return
    setLoading(true)
    const res = await signInWithGoogle()
    setLoading(false)
    if (!res.ok) { if (!res.cancelled) Alert.alert(t('common.error'), res.error ?? t('errors.google_failed')); return }
    setStep('profile') // collect quick profile → creates the user + msme profile
  }

  async function saveProfile() {
    if (!fullName.trim() || !businessName.trim()) { Alert.alert(t('errors.title'), t('errors.name_business_required')); return }
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')
      // Acceptance rows first — /profile/msme is gated on them (403 otherwise).
      const legal = await fetch(`${API_URL}/api/v1/legal/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ docs: ['terms', 'privacy'], surface: 'mobile' }),
      })
      if (!legal.ok) throw new Error(t('errors.generic'))
      const res = await fetch(`${API_URL}/api/v1/profile/msme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ fullName: fullName.trim(), businessName: businessName.trim() }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Profile save failed') }
      router.replace('/(app)/home')
    } catch (e: unknown) {
      Alert.alert(t('common.error'), e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setLoading(false)
    }
  }

  const heading = step === 'profile' ? t('msme_signup.step_profile_title') : step === 'otp' ? t('auth.enter_otp') : t('auth.sign_up')
  const identifierLabel = method === 'phone' ? `+91 ${phone}` : email

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1">
        <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-10">
          <View className="mb-10 items-center">
            <Text className="text-3xl font-bold text-primary">AMClub</Text>
            <Text className="mt-2 text-base text-foreground-secondary text-center">{heading}</Text>
          </View>

          {step === 'auth' && (
            <View className="gap-4">
              {method === 'phone' ? (
                <View className="flex-row items-center rounded-xl border border-gray-200 bg-surface px-4 py-3">
                  <Text className="mr-2 text-base font-medium text-foreground">+91</Text>
                  <View className="h-5 w-px bg-gray-300 mr-2" />
                  <TextInput className="flex-1 text-base text-foreground" placeholder={t('auth.phone_placeholder')} placeholderTextColor="#9CA3AF" keyboardType="phone-pad" maxLength={10} value={phone} onChangeText={setPhone} />
                </View>
              ) : (
                <View className="rounded-xl border border-gray-200 bg-surface px-4 py-3">
                  <TextInput className="text-base text-foreground" placeholder={t('auth.email_placeholder')} placeholderTextColor="#9CA3AF" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} />
                </View>
              )}
              {/* Phase 2b — explicit consent checkbox (replaces the passive line). */}
              <TouchableOpacity onPress={() => setAgreed((a) => !a)} accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} className="flex-row items-start gap-3 rounded-xl border border-gray-200 bg-surface px-4 py-3">
                <View className={`mt-0.5 h-5 w-5 items-center justify-center rounded border ${agreed ? 'border-primary bg-primary' : 'border-gray-400 bg-surface'}`}>
                  {agreed && <Text className="text-xs font-bold text-white">✓</Text>}
                </View>
                <Text className="flex-1 text-sm leading-5 text-foreground">
                  {t('auth.consent_prefix')}{' '}
                  <Text className="text-primary underline" onPress={() => Linking.openURL(`${API_URL}/terms`)}>{t('auth.consent_terms')}</Text>
                  {' '}{t('auth.consent_and')}{' '}
                  <Text className="text-primary underline" onPress={() => Linking.openURL(`${API_URL}/privacy`)}>{t('auth.consent_privacy')}</Text>.
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={sendOtp} disabled={loading || !agreed} className={`rounded-xl py-4 items-center ${loading || !agreed ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('auth.send_otp_btn')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setMethod((m) => (m === 'phone' ? 'email' : 'phone'))} className="items-center">
                <Text className="text-sm text-primary">{method === 'phone' ? t('auth.use_email') : t('auth.use_phone')}</Text>
              </TouchableOpacity>
              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-gray-200" /><Text className="text-xs text-foreground-secondary">{t('common.or')}</Text><View className="h-px flex-1 bg-gray-200" />
              </View>
              <TouchableOpacity onPress={google} disabled={loading} className="flex-row items-center justify-center gap-2 rounded-xl border border-gray-200 bg-surface py-4">
                <Text className="text-base font-semibold text-foreground">{t('auth.continue_with_google')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.push('/(auth)/login')} className="items-center">
                <Text className="text-sm text-foreground-secondary">{t('auth.have_account')}{' '}<Text className="font-semibold text-primary">{t('auth.sign_in')}</Text></Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'otp' && (
            <View className="gap-4">
              <Text className="text-sm text-foreground-secondary text-center">{t('auth.otp_sent_to')} {identifierLabel}</Text>
              <TextInput className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-center text-2xl font-bold tracking-widest text-foreground" placeholder="— — — — — —" placeholderTextColor="#9CA3AF" keyboardType="number-pad" maxLength={6} value={otp} onChangeText={setOtp} />
              <TouchableOpacity onPress={verifyOtp} disabled={loading} className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('auth.verify_btn')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep('auth')} className="items-center">
                <Text className="text-sm text-primary">{method === 'phone' ? t('auth.change_number') : t('auth.change_email')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'profile' && (
            <View className="gap-4">
              <TextInput className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-base text-foreground" placeholder={t('auth.name_label')} placeholderTextColor="#9CA3AF" value={fullName} onChangeText={setFullName} />
              <TextInput className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-base text-foreground" placeholder={t('msme_signup.business_name_label')} placeholderTextColor="#9CA3AF" value={businessName} onChangeText={setBusinessName} />
              <TouchableOpacity onPress={saveProfile} disabled={loading} className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('common.continue')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
