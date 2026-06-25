export interface GstinVerifyResult {
  verified: boolean
  legalName?: string
  tradeName?: string
  state?: string
  registrationDate?: string
  isActive?: boolean
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
  verifyBankAccount(params: {
    accountNumber: string
    ifsc: string
    holderName: string
  }): Promise<BankVerifyResult>
}
