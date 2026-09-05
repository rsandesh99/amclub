import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect } from 'react'
import { useFonts, NotoSansTelugu_400Regular, NotoSansTelugu_600SemiBold } from '@expo-google-fonts/noto-sans-telugu'
import { I18nProvider } from '@/lib/i18n'
import '../global.css'

SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  // S3.5 — bundle Noto Sans Telugu so te renders in the brand face (Android
  // system Noto rendered it before; this matches web). Hide the splash once
  // fonts resolve OR error — a font-fetch failure must never wedge launch
  // (Android still renders Telugu via the system face in that case).
  const [fontsLoaded, fontError] = useFonts({ NotoSansTelugu_400Regular, NotoSansTelugu_600SemiBold })

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync()
  }, [fontsLoaded, fontError])

  return (
    <I18nProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#1B4D3E' },
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: '#FAFAF7' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'AMClub', headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
      </Stack>
    </I18nProvider>
  )
}
