import { useEffect, useState } from 'react'
import { Tabs, router } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { ProfileMeResponse } from '@amclub/shared'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { API_URL } from '@/lib/api'
import { hydrateMartCart } from '@/lib/mart-cart'
import { LegalGateModal } from '@/components/LegalGateModal'

/** AMC Mart dark build — the tab exists only when /profile/me says the
 *  server flag is on. Unknown (fetch failed / not yet loaded) = hidden. */
async function fetchMartEnabled(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/v1/profile/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return false
    const data = (await res.json()) as Partial<ProfileMeResponse>
    return data.martEnabled === true
  } catch {
    return false
  }
}

export default function AppLayout() {
  const { t } = useI18n()
  const [checking, setChecking] = useState(true)
  const [martEnabled, setMartEnabled] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace('/(auth)/login')
      setChecking(false)
      if (session) {
        // Fetched once after auth; the tab stays hidden until the server says on.
        fetchMartEnabled(session.access_token).then(setMartEnabled)
        void hydrateMartCart()
      }
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
    <>
    {/* Phase 2b — blocks the authenticated app until current-version legal docs are accepted. */}
    <LegalGateModal />
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
      {/* AMC Mart (goods) — dark build: hidden unless the server flag is on. */}
      <Tabs.Screen
        name="mart/index"
        options={{
          title: t('tabs.mart'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="storefront-outline" color={color} size={size} />,
          ...(martEnabled ? {} : { href: null }),
        }}
      />
      <Tabs.Screen name="mart/[id]" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="mart/cart" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="mart/pools" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="mart/pool/[id]" options={{ href: null, headerShown: false }} />
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
      <Tabs.Screen name="partner-munshi" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="support" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="assistant" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="notifications" options={{ href: null, headerShown: false }} />
    </Tabs>
    </>
  )
}
