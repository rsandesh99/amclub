import { useEffect } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'

export default function IndexScreen() {
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        router.replace('/(auth)/login')
        return
      }
      const roles: string[] = session.user.user_metadata?.['roles'] ?? ['msme']
      if (roles.includes('provider')) {
        router.replace('/(app)/partner')
      } else {
        router.replace('/(app)/home')
      }
    })
  }, [])

  return (
    <View className="flex-1 items-center justify-center bg-background">
      <ActivityIndicator size="large" color="#1B4D3E" />
    </View>
  )
}
