/**
 * Surepass KYC client — used when KYC_API_KEY is set.
 *
 * Provision: sign up at https://surepass.io → get an API token.
 * Set KYC_API_KEY=<token> in .env.local.
 *
 * Endpoints used:
 *   GSTIN:       POST https://kyc-api.surepass.io/api/v1/corporate/gstin
 *   Bank verify: POST https://kyc-api.surepass.io/api/v1/bank-verification
 *   Udyam:       POST https://kyc-api.surepass.io/api/v1/corporate/udyam
 */
import type { KycClient, GstinVerifyResult, BankVerifyResult, UdyamVerifyResult } from './types'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'

const BASE = 'https://kyc-api.surepass.io/api/v1'

async function post(path: string, body: object, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    // Audit M37: a slow registry never holds the request; the callers' catch turns it into "try again".
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.kyc),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Surepass ${path} HTTP ${res.status}: ${text}`)
  }
  return res.json()
}

export function makeSurepassClient(apiKey: string): KycClient {
  return {
    async verifyGstin(gstin: string): Promise<GstinVerifyResult> {
      try {
        const data = await post('/corporate/gstin', { id_number: gstin }, apiKey)
        const d = data?.data ?? {}
        return {
          verified: data.success === true,
          legalName: d.legal_name,
          tradeName: d.trade_name,
          state: d.state_jurisdiction,
          registrationDate: d.date_of_registration,
          // gstin_status is the registry status ("Active" / "Cancelled" / "Suspended"); older payloads
          // carried only taxpayer_type, which is kept as the fallback.
          isActive: typeof d.gstin_status === 'string' ? d.gstin_status.toLowerCase() === 'active' : d.taxpayer_type !== 'Cancelled',
          ...(typeof d.gstin_status === 'string' ? { statusText: d.gstin_status } : {}),
          ...(typeof d.address === 'string' && d.address.trim() ? { address: d.address.trim() } : {}),
        }
      } catch (e: unknown) {
        return { verified: false, error: e instanceof Error ? e.message : 'KYC error' }
      }
    },

    async verifyUdyam(udyamNumber: string): Promise<UdyamVerifyResult> {
      try {
        const data = await post('/corporate/udyam', { id_number: udyamNumber }, apiKey)
        const d = data?.data ?? {}
        return {
          verified: data.success === true,
          enterpriseName: d.enterprise_name ?? d.name_of_enterprise,
          majorActivity: d.major_activity,
          state: d.state,
          registrationDate: d.date_of_registration ?? d.date_of_udyam_registration,
        }
      } catch (e: unknown) {
        return { verified: false, error: e instanceof Error ? e.message : 'KYC error' }
      }
    },

    async verifyBankAccount(params): Promise<BankVerifyResult> {
      try {
        const data = await post(
          '/bank-verification',
          {
            id_number: params.accountNumber,
            ifsc: params.ifsc,
            ifsc_details: false,
          },
          apiKey,
        )
        const d = data?.data ?? {}
        return {
          verified: data.success === true && d.account_exists === 'yes',
          accountHolderName: d.full_name,
        }
      } catch (e: unknown) {
        return { verified: false, error: e instanceof Error ? e.message : 'KYC error' }
      }
    },
  }
}
