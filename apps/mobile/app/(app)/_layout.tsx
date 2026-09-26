import { useEffect, useState, type ComponentProps } from 'react'
import { Tabs, router } from 'expo-router'
import { ActivityIndicator, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { initialMobileRole, mobileRolesOf, mobileTabsFor, type MobileRole, type MobileTab, type ProfileMeResponse } from '@amclub/shared'
import { supabase } from '@/lib/supabase'
import { useI18n } from '@/lib/i18n'
import { API_URL } from '@/lib/api'
import { hydrateMartCart } from '@/lib/mart-cart'
import { loadStoredRole, setMobileRole, useMobileRole } from '@/lib/role'
import { LegalGateModal } from '@/components/LegalGateModal'

/** The server's view of this user (AMC Mart flag, E13 mobile flag, roles). Unknown (fetch failed / not yet loaded) = everything off. */
async function fetchMeFlags(accessToken: string): Promise<Partial<ProfileMeResponse>> {
  try {
    const res = await fetch(`${API_URL}/api/v1/profile/me`, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return {}
    return (await res.json()) as Partial<ProfileMeResponse>
  } catch {
    return {}
  }
}

type IconName = ComponentProps<typeof Ionicons>['name']

/** E13 — each v3 tab key → the route it opens, its title key and icon. */
const V3_TABS: Record<MobileTab, { route: string; title: string; icon: IconName }> = {
  home: { route: 'home', title: 'tabs.home', icon: 'home-outline' },
  search: { route: 'search', title: 'tabs.search', icon: 'search-outline' },
  requirements: { route: 'rfq/index', title: 'tabs.requirements', icon: 'document-text-outline' },
  orders: { route: 'orders/index', title: 'tabs.orders', icon: 'cube-outline' },
  saved: { route: 'saved', title: 'tabs.saved', icon: 'heart-outline' },
  mart: { route: 'mart/index', title: 'tabs.mart', icon: 'storefront-outline' },
  today: { route: 'partner', title: 'tabs.today', icon: 'today-outline' },
  rfqs: { route: 'partner-rfqs', title: 'tabs.rfqs', icon: 'mail-unread-outline' },
  listings: { route: 'partner-listings', title: 'tabs.listings', icon: 'pricetags-outline' },
  earnings: { route: 'partner-earnings', title: 'tabs.earnings', icon: 'wallet-outline' },
}

/** Every route in the group, so each is registered once; the v3 bar shows the role's tabs first, in order. */
const ALL_ROUTES = [
  'home', 'search', 'saved', 'orders/index', 'partner', 'mart/index',
  'mart/[id]', 'mart/cart', 'mart/pools', 'mart/pool/[id]',
  'category/[slug]', 'provider/[slug]', 'package/[providerSlug]/[packageSlug]', 'checkout/[packageId]',
  'orders/[id]', 'rfq/index', 'rfq/new', 'rfq/[id]', 'partner-rfqs', 'partner-rfq/[id]', 'partner-munshi',
  'support', 'assistant', 'notifications',
  'partner-listings', 'partner-earnings', 'profile', 'invoices',
  'partner-reviews', 'partner-insights', 'partner-profile', 'partner-onboarding',
  // PRD_WHATSAPP W1 — Help, WhatsApp, notification settings and privacy requests, for everyone.
  'help', 'whatsapp-settings', 'notification-settings', 'privacy',
] as const

export default function AppLayout() {
  const { t } = useI18n()
  const [checking, setChecking] = useState(true)
  const [me, setMe] = useState<Partial<ProfileMeResponse>>({})
  const role = useMobileRole()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace('/(auth)/login')
      setChecking(false)
      if (session) {
        // Fetched once after auth; the Mart tab and the v3 bar stay off until the server says on.
        void fetchMeFlags(session.access_token).then(async (flags) => {
          setMe(flags)
          if (flags.mobileV3Enabled === true) {
            const available = mobileRolesOf({ roles: flags.roles ?? [], hasProviderProfile: flags.hasProviderProfile === true, hasMsmeProfile: flags.hasMsmeProfile === true })
            setMobileRole(initialMobileRole(available, await loadStoredRole()))
          }
        })
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

  const martEnabled = me.martEnabled === true
  const screenOptions = {
    tabBarActiveTintColor: '#1B4D3E',
    tabBarInactiveTintColor: '#5C645C',
    headerStyle: { backgroundColor: '#1B4D3E' },
    headerTintColor: '#FFFFFF',
    tabBarStyle: { minHeight: 56 },
  }

  // ── E13 v3: role-aware bars (buyer: Home · Search · Requirements · Orders · Saved (+ Mart); provider: Today · RFQs · Orders · Listings · Earnings) ──
  if (me.mobileV3Enabled === true && role) {
    const tabs = mobileTabsFor({ role: role as MobileRole, martEnabled })
    const visible = tabs.map((k) => V3_TABS[k])
    const visibleRoutes = new Set(visible.map((v) => v.route))
    const hidden = ALL_ROUTES.filter((r) => !visibleRoutes.has(r))
    return (
      <>
        <LegalGateModal />
        <Tabs key={role} screenOptions={screenOptions}>
          {visible.map((v) => (
            <Tabs.Screen
              key={v.route}
              name={v.route}
              options={{ title: t(v.title), headerShown: false, tabBarIcon: ({ color, size }) => <Ionicons name={v.icon} color={color} size={size} /> }}
            />
          ))}
          {hidden.map((r) => <Tabs.Screen key={r} name={r} options={{ href: null, headerShown: false }} />)}
        </Tabs>
      </>
    )
  }

  return (
    <>
    {/* Phase 2b — blocks the authenticated app until current-version legal docs are accepted. */}
    <LegalGateModal />
    <Tabs screenOptions={screenOptions}>
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
      {/* E13 screens — reachable only while the mobile flag is on (their routes 404 otherwise). */}
      <Tabs.Screen name="partner-listings" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-earnings" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="profile" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="invoices" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-reviews" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-insights" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-profile" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="partner-onboarding" options={{ href: null, headerShown: false }} />
      {/* PRD_WHATSAPP W1 — reachable for everyone (Help from the home header, settings from Help / notifications). */}
      <Tabs.Screen name="help" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="whatsapp-settings" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="notification-settings" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="privacy" options={{ href: null, headerShown: false }} />
    </Tabs>
    </>
  )
}
