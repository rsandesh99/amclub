import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { normalisePhone, isEmail, signInWithGoogle, routeForRoles } from '@/lib/auth'

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

  async function sendOtp() {
    setLoading(true)
    try {
      if (method === 'phone') {
        const normalised = normalisePhone(phone)
        if (normalised.length < 13) { Alert.alert('Invalid number', 'Enter a valid 10-digit mobile number.'); return }
        const { error } = await supabase.auth.signInWithOtp({ phone: normalised, options: { shouldCreateUser: true } })
        if (error) { Alert.alert('Error', error.message); return }
      } else {
        if (!isEmail(email)) { Alert.alert('Invalid email', 'Enter a valid email address.'); return }
        const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } })
        if (error) { Alert.alert('Error', error.message); return }
      }
      setStep('otp')
    } finally {
      setLoading(false)
    }
  }

  async function verifyOtp() {
    if (otp.length !== 6) { Alert.alert('Invalid code', 'Enter the 6-digit code.'); return }
    setLoading(true)
    try {
      const { data, error } =
        method === 'phone'
          ? await supabase.auth.verifyOtp({ phone: normalisePhone(phone), token: otp, type: 'sms' })
          : await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: otp, type: 'email' })
      if (error || !data.user) { Alert.alert('Error', error?.message ?? 'Verification failed'); return }
      const roles: string[] = data.user.user_metadata?.['roles'] ?? ['msme']
      router.replace(routeForRoles(roles) as never)
    } finally {
      setLoading(false)
    }
  }

  async function google() {
    setLoading(true)
    const res = await signInWithGoogle()
    setLoading(false)
    if (!res.ok) { if (!res.cancelled) Alert.alert('Google sign-in', res.error ?? 'Failed'); return }
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
                    keyboardType="phone-pad" maxLength={10} value={phone} onChangeText={setPhone}
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
                placeholder="— — — — — —" placeholderTextColor="#9CA3AF" keyboardType="number-pad" maxLength={6} value={otp} onChangeText={setOtp}
              />
              <TouchableOpacity onPress={verifyOtp} disabled={loading} className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}>
                <Text className="text-base font-semibold text-white">{loading ? t('common.loading') : t('auth.verify_btn')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep('input')} className="items-center">
                <Text className="text-sm text-primary">{method === 'phone' ? t('auth.change_number') : t('auth.change_email')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
