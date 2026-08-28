import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { bankFacts, payoutReadiness, type BankFacts, type PayoutReadiness } from './readiness'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** Readiness facts for one provider (status only — never the account number). */
export async function getProviderReadiness(
  admin: Admin,
  providerId: string,
): Promise<{ readiness: PayoutReadiness; facts: BankFacts }> {
  const { data } = await admin
    .from('provider_bank_accounts')
    .select('penny_drop_verified, razorpay_route_account_id')
    .eq('provider_id', providerId)
    .maybeSingle()
  const facts = bankFacts(data)
  return { readiness: payoutReadiness(facts), facts }
}
