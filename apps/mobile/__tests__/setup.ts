// E13 component tests: native modules the screens touch, stubbed.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}))
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => undefined), ImpactFeedbackStyle: { Light: 'light' } }))
jest.mock('@/lib/analytics', () => ({ track: jest.fn() }))
jest.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })), signOut: jest.fn() } } }))
jest.mock('expo-router', () => {
  const React = jest.requireActual('react')
  return {
    router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
    useFocusEffect: (cb: () => void) => { React.useEffect(cb, [cb]) },
    useLocalSearchParams: jest.fn(() => ({})),
  }
})
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: unknown }) => children }))
