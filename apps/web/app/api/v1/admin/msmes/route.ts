import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — MSME list/search (q over business name, ?state=). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const q = sp.get('q')?.trim()
  const state = sp.get('state')

  const admin = await createAdminClient()
  let query = admin
    .from('msme_profiles')
    .select('id, business_name, sector, state, city, membership_tier, gstin_verified, created_at, deleted_at')
    .order('created_at', { ascending: false })
    .limit(200)
  if (q) {
    // Ops look people up by what a caller gives them: phone, email, GSTIN or name.
    const digits = q.replace(/\D/g, '')
    const gstin = q.toUpperCase().replace(/\s/g, '')
    if (q.includes('@') || digits.length >= 10) {
      const national = digits.slice(-10)
      const base = admin.from('users').select('id').limit(20)
      // Plain eq/in filters — the search text never becomes PostgREST filter syntax.
      // Phone rows may carry +91…, 91… or the bare 10 digits depending on the auth path.
      const { data: users } = q.includes('@')
        ? await base.eq('email', q.toLowerCase())
        : await base.in('phone', [`+91${national}`, `91${national}`, national])
      const ids = (users ?? []).map((u) => u.id as string)
      if (ids.length === 0) return NextResponse.json({ msmes: [] })
      query = query.in('user_id', ids)
    } else if (/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) {
      query = query.eq('gstin', gstin)
    } else {
      query = query.ilike('business_name', `%${q.replace(/[%_\\]/g, ' ')}%`)
    }
  }
  if (state) query = query.eq('state', state)
  const { data } = await query
  return NextResponse.json({ msmes: data ?? [] })
}
