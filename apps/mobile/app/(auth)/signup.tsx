import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState } from 'react'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'

type Step = 'phone' | 'otp' | 'profile'

function normalisePhone(raw: string) {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) return '+' + digits
  if (digits.length === 10) return '+91' + digits
  return '+' + digits
}

export default function SignupScreen() {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('phone')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [fullName, setFullName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [loading, setLoading] = useState(false)

  async function sendOtp() {
    const normalised = normalisePhone(phone)
    if (normalised.length < 13) {
      Alert.alert('Invalid number', 'Enter a valid 10-digit mobile number.')
      return
    }
    setLoading(true)
    const { error } = await supabase.auth.signInWithOtp({ phone: normalised })
    setLoading(false)
    if (error) { Alert.alert('Error', error.message); return }
    setStep('otp')
  }

  async function verifyOtp() {
    const normalised = normalisePhone(phone)
    if (otp.length !== 6) { Alert.alert('Invalid OTP', 'Enter the 6-digit OTP.'); return }
    setLoading(true)
    const { error } = await supabase.auth.verifyOtp({
      phone: normalised,
      token: otp,
      type: 'sms',
    })
    setLoading(false)
    if (error) { Alert.alert('Error', error.message); return }
    setStep('profile')
  }

  async function saveProfile() {
    if (!fullName.trim() || !businessName.trim()) {
      Alert.alert('Required', 'Please fill in your name and business name.')
      return
    }
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')
      const res = await fetch(`${process.env['EXPO_PUBLIC_API_URL'] ?? ''}/api/v1/profile/msme`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          fullName: fullName.trim(),
          businessName: businessName.trim(),
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Profile save failed')
      }
      router.replace('/(app)/home')
    } catch (e: any) {
      Alert.alert('Error', e.message)
    } finally {
      setLoading(false)
    }
  }

  const steps: Record<Step, string> = {
    phone: t('auth.sign_up'),
    otp: t('auth.enter_otp'),
    profile: t('msme_signup.step_profile_title'),
  }

  return (
    <SafeAreaView className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView contentContainerClassName="flex-grow justify-center px-6 py-10">
          <View className="mb-10 items-center">
            <Text className="text-3xl font-bold text-primary">AMClub</Text>
            <Text className="mt-2 text-base text-foreground-secondary text-center">
              {steps[step]}
            </Text>
          </View>

          {step === 'phone' && (
            <View className="gap-4">
              <View className="flex-row items-center rounded-xl border border-gray-200 bg-surface px-4 py-3">
                <Text className="mr-2 text-base font-medium text-foreground">+91</Text>
                <View className="h-5 w-px bg-gray-300 mr-2" />
                <TextInput
                  className="flex-1 text-base text-foreground"
                  placeholder={t('auth.phone_placeholder')}
                  placeholderTextColor="#9CA3AF"
                  keyboardType="phone-pad"
                  maxLength={10}
                  value={phone}
                  onChangeText={setPhone}
                />
              </View>
              <TouchableOpacity
                onPress={sendOtp}
                disabled={loading}
                className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}
              >
                <Text className="text-base font-semibold text-white">
                  {loading ? t('common.loading') : t('auth.send_otp_btn')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => router.push('/(auth)/login')} className="items-center">
                <Text className="text-sm text-foreground-secondary">
                  {t('auth.have_account')}{' '}
                  <Text className="font-semibold text-primary">{t('auth.sign_in')}</Text>
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'otp' && (
            <View className="gap-4">
              <Text className="text-sm text-foreground-secondary text-center">
                {t('auth.otp_sent_to')} +91 {phone}
              </Text>
              <TextInput
                className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-center text-2xl font-bold tracking-widest text-foreground"
                placeholder="— — — — — —"
                placeholderTextColor="#9CA3AF"
                keyboardType="number-pad"
                maxLength={6}
                value={otp}
                onChangeText={setOtp}
              />
              <TouchableOpacity
                onPress={verifyOtp}
                disabled={loading}
                className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}
              >
                <Text className="text-base font-semibold text-white">
                  {loading ? t('common.loading') : t('auth.verify_btn')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setStep('phone')} className="items-center">
                <Text className="text-sm text-primary">{t('auth.change_number')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'profile' && (
            <View className="gap-4">
              <TextInput
                className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-base text-foreground"
                placeholder={t('auth.name_label')}
                placeholderTextColor="#9CA3AF"
                value={fullName}
                onChangeText={setFullName}
              />
              <TextInput
                className="rounded-xl border border-gray-200 bg-surface px-4 py-3 text-base text-foreground"
                placeholder={t('msme_signup.business_name_label')}
                placeholderTextColor="#9CA3AF"
                value={businessName}
                onChangeText={setBusinessName}
              />
              <TouchableOpacity
                onPress={saveProfile}
                disabled={loading}
                className={`rounded-xl py-4 items-center ${loading ? 'bg-primary/60' : 'bg-primary'}`}
              >
                <Text className="text-base font-semibold text-white">
                  {loading ? t('common.loading') : t('common.continue')}
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}
