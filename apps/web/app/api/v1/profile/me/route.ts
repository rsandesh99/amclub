import { NextResponse } from 'next/server'
import { getSessionUser, getMsmeProfile, getProviderProfile } from '@/lib/auth/session'

export async function GET() {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 })
  }

  const msmeProfile = await getMsmeProfile(user.id)
  const providerProfile = user.roles.includes('provider')
    ? await getProviderProfile(user.id)
    : null

  // Primary role for redirect decisions
  const primaryRole = user.roles.includes('admin') || user.roles.includes('ops')
    ? 'admin'
    : user.roles.includes('provider')
    ? 'provider'
    : 'msme'

  return NextResponse.json({
    authenticated: true,
    id: user.id,
    role: primaryRole,
    roles: user.roles,
    hasMsmeProfile: !!msmeProfile,
    hasProviderProfile: !!providerProfile,
    providerStatus: providerProfile?.status ?? null,
  })
}
