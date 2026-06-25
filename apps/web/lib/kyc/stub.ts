/**
 * Dev stub — used when KYC_API_KEY is missing or placeholder.
 * All verifications succeed instantly so the flow works end-to-end.
 *
 * ⚠ PROVISION BEFORE GOING LIVE:
 *   Set KYC_API_KEY to a real Surepass or Signzy key in .env.local.
 *   The stub will be bypassed automatically once the key is present.
 */
import type { KycClient, GstinVerifyResult, BankVerifyResult } from './types'

export const stubKycClient: KycClient = {
  async verifyGstin(gstin: string): Promise<GstinVerifyResult> {
    console.warn('[KYC STUB] verifyGstin called — not a real API call. GSTIN:', gstin)
    await new Promise((r) => setTimeout(r, 600))
    return {
      verified: true,
      legalName: 'Stub Business Pvt Ltd',
      tradeName: 'Stub Business',
      state: 'MH',
      registrationDate: '2020-01-01',
      isActive: true,
      stub: true,
    }
  },

  async verifyBankAccount(params): Promise<BankVerifyResult> {
    console.warn('[KYC STUB] verifyBankAccount called — not a real API call.', params.accountNumber, params.ifsc)
    await new Promise((r) => setTimeout(r, 800))
    return {
      verified: true,
      accountHolderName: params.holderName,
      stub: true,
    }
  },
}
