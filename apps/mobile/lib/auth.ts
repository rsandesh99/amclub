import * as WebBrowser from 'expo-web-browser'
import * as Linking from 'expo-linking'
import { supabase } from './supabase'

WebBrowser.maybeCompleteAuthSession()

/** Where to send the user after auth, based on their roles. */
export function routeForRoles(roles: string[]): string {
  if (roles.includes('provider')) return '/(app)/partner'
  return '/(app)/home'
}

/** E.164-normalise an Indian mobile number. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('91') && digits.length === 12) return '+' + digits
  if (digits.length === 10) return '+91' + digits
  return '+' + digits
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isEmail = (v: string) => EMAIL_RE.test(v.trim())

/**
 * Google OAuth via the system browser (PKCE). The provider must be enabled in
 * Supabase and the app's deep-link redirect URL allow-listed. Returns ok/error.
 */
export async function signInWithGoogle(): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const redirectTo = Linking.createURL('auth-callback')
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  })
  if (error || !data?.url) return { ok: false, error: error?.message ?? 'Google sign-in unavailable' }

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
  if (result.type !== 'success' || !result.url) return { ok: false, cancelled: true }

  const code = new URL(result.url).searchParams.get('code')
  if (!code) return { ok: false, error: 'No authorization code returned' }

  const { error: exErr } = await supabase.auth.exchangeCodeForSession(code)
  if (exErr) return { ok: false, error: exErr.message }
  return { ok: true }
}
