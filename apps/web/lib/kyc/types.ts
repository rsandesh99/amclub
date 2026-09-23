export interface GstinVerifyResult {
  verified: boolean
  legalName?: string
  tradeName?: string
  state?: string
  registrationDate?: string
  isActive?: boolean
  /** The registry's status text ("Active", "Cancelled", "Suspended") — the reason shown when not active. */
  statusText?: string
  /** Principal place of business, only when the vendor returns one. */
  address?: string
  error?: string
  stub?: boolean
}

export interface UdyamVerifyResult {
  verified: boolean
  enterpriseName?: string
  majorActivity?: string
  state?: string
  registrationDate?: string
  error?: string
  stub?: boolean
}

export interface BankVerifyResult {
  verified: boolean
  accountHolderName?: string
  error?: string
  stub?: boolean
}

export interface KycClient {
  verifyGstin(gstin: string): Promise<GstinVerifyResult>
  /** S0.4 — Udyam registration lookup (Surepass /corporate/udyam). */
  verifyUdyam(udyamNumber: string): Promise<UdyamVerifyResult>
  verifyBankAccount(params: {
    accountNumber: string
    ifsc: string
    holderName: string
  }): Promise<BankVerifyResult>
}
