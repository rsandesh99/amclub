import { useEffect, useState } from 'react'
import { Tabs, router } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'

export default function AppLayout() {
  const { t } = useI18n()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace('/(auth)/login')
      setChecking(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace('/(auth)/login')
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
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#1B4D3E',
        tabBarInactiveTintColor: '#5C645C',
        headerStyle: { backgroundColor: '#1B4D3E' },
        headerTintColor: '#FFFFFF',
        tabBarStyle: { minHeight: 56 },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: t('tabs.home'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: t('tabs.search'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="search-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: t('tabs.saved'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="heart-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="orders/index"
        options={{
          title: t('tabs.orders'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="cube-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="partner"
        options={{
          title: t('tabs.partner'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="briefcase-outline" color={color} size={size} />,
        }}
      />
      {/* Detail screens — navigable via push, hidden from the tab bar. */}
      <Tabs.Screen name="category/[slug]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="provider/[slug]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="package/[providerSlug]/[packageSlug]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="checkout/[packageId]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="orders/[id]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="rfq/index" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="rfq/new" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="rfq/[id]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-rfqs" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-rfq/[id]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="notifications" options={{ href: null, headerShown: false }} />
    </Tabs>
  )
}
