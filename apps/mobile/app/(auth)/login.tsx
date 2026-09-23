import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useEffect, useRef, useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { LocaleToggle } from '@/components/LocaleToggle'
import { isEmail, signInWithGoogle, routeForRoles } from '@/lib/auth'
import { normalizeIndianPhone, phoneSchema, toE164India } from '@amclub/shared'

type Method = 'phone' | 'email'
type Step = 'input' | 'otp'

export default function LoginScreen() {
  const { t } = useI18n()
  const [method, setMethod] = useState<Method>('phone')
  const [step, setStep] = useState<Step>('input')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  // 30 s resend countdown on the OTP step; the single-flight guard keeps
  // SMS autofill / typing the 6th digit / the button from double-verifying.
  const [resendIn, setResendIn] = useState(0)
  const verifyingRef = useRef(false)

  useEffect(() => {
    if (step !== 'otp' || resendIn <= 0) return
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [step, resendIn])

  async function sendOtp() {
    setLoading(true)
    try {
      if (method === 'phone') {
        // Paste-safe: "+91 98765 43210" → national 9876543210 → +919876543210.
        if (!phoneSchema.safeParse(normalizeIndianPhone(phone)).success) { Alert.alert(t('errors.title'), t('errors.invalid_phone')); return }
        const { error } = await supabase.auth.signInWithOtp({ phone: toE164India(phone), options: { shouldCreateUser: true } })
        if (error) { Alert.alert(t('common.error'), error.message); return }
      } else {
        if (!isEmail(email)) { Alert.alert(t('errors.title'), t('errors.invalid_email')); return }
        const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } })
        if (error) { Alert.alert(t('common.error'), error.message); return }
      }
      setOtp('')
      setResendIn(30)
      setStep('otp')
    } finally {
      setLoading(false)
    }
  }

  async function verifyOtp(code: string = otp) {
    if (code.length !== 6) { Alert.alert(t('errors.title'), t('errors.invalid_code')); return }
    if (verifyingRef.current) return
    verifyingRef.current = true
    setLoading(true)
    try {
      const { data, error } =
        method === 'phone'
          ? await supabase.auth.verifyOtp({ phone: toE164India(phone), token: code, type: 'sms' })
          : await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code, type: 'email' })
      if (error || !data.user) { setOtp(''); Alert.alert(t('common.error'), error?.message ?? t('errors.generic')); return }
      const roles: string[] = data.user.user_metadata?.['roles'] ?? ['msme']
      router.replace(routeForRoles(roles) as never)
    } finally {
      verifyingRef.current = false
      setLoading(false)
    }
  }

  function onOtpChange(value: string) {
    const code = value.replace(/\D/g, '').slice(0, 6)
    setOtp(code)
    if (code.length === 6) void verifyOtp(code)
  }

  async function google() {
    setLoading(true)
    const res = await signInWithGoogle()
    setLoading(false)
    if (!res.ok) { if (!res.cancelled) Alert.alert(t('common.error'), res.error ?? t('errors.google_failed')); return }
    const { data } = await supabase.auth.getUser()
    router.replace(routeForRoles(data.user?.user_metadata?.['roles'] ?? ['msme']) as never)
  }

  const identifierLabel = method === 'phone' ? `+91 ${phone}` : email

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} className="flex-1">
        <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-10">
          <View className="mb-10 items-center">
            <Text className="text-3xl font-bold text-primary">AMClub</Text>
            <Text className="mt-2 text-base text-foreground-secondary text-center">
              {step === 'input' ? t('auth.sign_in_title') : t('auth.enter_otp')}
            </Text>
            <View className="mt-4">
              <LocaleToggle />
            </View>
          </View>

          {step === 'input' ? (
            <View className="gap-4">
              {method === 'phone' ? (
                <View className="flex-row items-center rounded-xl border border-gray-200 bg-surface px-4 py-3">
                  <Text className="mr-2 text-base font-medium text-foreground">+91</Text>
                  <View className="h-5 w-px bg-gray-300 mr-2" />
                  <TextInput
                    className="flex-1 text-base text-foreground"
                    placeholder={t('auth.phone_placeholder')} placeholderTextColor="#9CA3AF"
                    keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel"
                    accessibilityLabel={t('auth.phone_label')}
                    value={phone} onChangeText={(v) => setPhone(normalizeIndianPhone(v))}
                  />
                </View>
              ) : (
                <View className="rounded-xl border border-gray-200 bg-surface px-4 py-3">
                  <TextInput
                    className="text-base text-foreground"
                    placeholder={t('auth.email_placeholder')} placeholderTextColor="#9CA3AF"
                    keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail}
                  />
                </View>
              )}

              <TouchableOpacity onPress={sendOtp} disabled={loading} className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('auth.send_otp_btn')}</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setMethod((m) => (m === 'phone' ? 'email' : 'phone'))} className="items-center">
                <Text className="text-sm text-primary">{method === 'phone' ? t('auth.use_email') : t('auth.use_phone')}</Text>
              </TouchableOpacity>

              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-gray-200" />
                <Text className="text-xs text-foreground-secondary">{t('common.or')}</Text>
                <View className="h-px flex-1 bg-gray-200" />
              </View>

              <TouchableOpacity onPress={google} disabled={loading} className="flex-row items-center justify-center gap-2 rounded-xl border border-gray-200 bg-surface py-4">
                <Text className="text-base font-semibold text-foreground">{t('auth.continue_with_google')}</Text>
              </TouchableOpacity>

              <TouchableOpacity onPress={() => router.push('/(auth)/signup')} className="mt-2 items-center">
                <Text className="text-sm text-foreground-secondary">{t('auth.no_account')}{' '}<Text className="font-semibold text-primary">{t('auth.sign_up')}</Text></Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View className="gap-4">
              <Text className="text-sm text-foreground-secondary text-center">{t('auth.otp_sent_to')} {identifierLabel}</Text>
              <TextInput
                className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-center text-2xl font-bold tracking-widest text-foreground"
                placeholder="— — — — — —" placeholderTextColor="#9CA3AF" keyboardType="number-pad"
                textContentType="oneTimeCode" autoComplete="sms-otp" autoFocus
                accessibilityLabel={t('auth.otp_label')}
                value={otp} onChangeText={onOtpChange} editable={!loading}
              />
              <TouchableOpacity onPress={() => void verifyOtp()} disabled={loading} className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('auth.verify_btn')}</Text>
              </TouchableOpacity>
              {resendIn > 0 ? (
                <Text className="text-center text-sm text-foreground-secondary">{t('auth.otp_resend_in', { seconds: resendIn })}</Text>
              ) : (
                <TouchableOpacity onPress={() => void sendOtp()} disabled={loading} accessibilityRole="button" className="min-h-[44px] items-center justify-center">
                  <Text className="text-sm font-semibold text-primary">{t('auth.otp_resend')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setOtp(''); setStep('input') }} accessibilityRole="button" className="min-h-[44px] items-center justify-center">
                <Text className="text-sm text-primary">{method === 'phone' ? t('auth.change_number') : t('auth.change_email')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
