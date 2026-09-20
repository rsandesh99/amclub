import 'server-only'
import type { KycClient } from './types'
import { stubKycClient } from './stub'
import { makeSurepassClient } from './surepass'

export type { KycClient, GstinVerifyResult, BankVerifyResult, UdyamVerifyResult } from './types'

const PLACEHOLDER_VALUES = ['<surepass-or-signzy-key>', 'placeholder', '']

function isRealKey(key: string | undefined): key is string {
  return !!key && !PLACEHOLDER_VALUES.includes(key)
}

let _client: KycClient | null = null

export function getKycClient(): KycClient {
  if (_client) return _client
  const key = process.env['KYC_API_KEY']
  _client = isRealKey(key) ? makeSurepassClient(key) : stubKycClient
  if (!isRealKey(key)) {
    console.warn(
      '⚠  KYC_API_KEY is not set — using dev stub. ' +
        'Provision a real Surepass or Signzy key before going live.',
    )
  }
  return _client
}
