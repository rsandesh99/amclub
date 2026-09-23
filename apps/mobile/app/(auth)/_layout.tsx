import { Stack } from 'expo-router'
import { useI18n } from '@/lib/i18n'

export default function AuthLayout() {
  const { t } = useI18n()
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1B4D3E' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: '#FAFAF7' },
      }}
    >
      <Stack.Screen name="login" options={{ title: t('auth.sign_in'), headerShown: false }} />
      <Stack.Screen name="signup" options={{ title: t('auth.sign_up'), headerShown: false }} />
      <Stack.Screen name="partner-signup" options={{ title: t('auth.partner_signup_title'), headerShown: false }} />
    </Stack>
  )
}
