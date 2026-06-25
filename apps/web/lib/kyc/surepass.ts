/**
 * Surepass KYC client — used when KYC_API_KEY is set.
 *
 * Provision: sign up at https://surepass.io → get an API token.
 * Set KYC_API_KEY=<token> in .env.local.
 *
 * Endpoints used:
 *   GSTIN:       POST https://kyc-api.surepass.io/api/v1/corporate/gstin
 *   Bank verify: POST https://kyc-api.surepass.io/api/v1/bank-verification
 */
import type { KycClient, GstinVerifyResult, BankVerifyResult } from './types'

const BASE = 'https://kyc-api.surepass.io/api/v1'

async function post(path: string, body: object, token: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
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
          isActive: d.taxpayer_type !== 'Cancelled',
        }
      } catch (e: any) {
        return { verified: false, error: e.message }
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
      } catch (e: any) {
        return { verified: false, error: e.message }
      }
    },
  }
}
