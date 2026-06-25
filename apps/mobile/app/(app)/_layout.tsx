import { useEffect, useState } from 'react'
import { Stack, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { ActivityIndicator, View } from 'react-native'

export default function AppLayout() {
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/(auth)/login')
      }
      setChecking(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        router.replace('/(auth)/login')
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  if (checking) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" color="#1B4D3E" />
      </View>
    )
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#1B4D3E' },
        headerTintColor: '#FFFFFF',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: '#FAFAF7' },
      }}
    >
      <Stack.Screen name="home" options={{ title: 'AMClub', headerShown: false }} />
      <Stack.Screen name="partner" options={{ title: 'Partner Dashboard', headerShown: false }} />
    </Stack>
  )
}
