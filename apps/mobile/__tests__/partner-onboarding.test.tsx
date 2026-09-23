import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerOnboardingScreen from '@/app/(app)/partner-onboarding'
import * as api from '@/lib/api'

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn(async () => ({ canceled: false, assets: [{ uri: 'file:///icai.pdf', name: 'icai.pdf', mimeType: 'application/pdf' }] })) }))
jest.mock('expo-image-picker', () => ({ requestCameraPermissionsAsync: jest.fn(async () => ({ granted: false })), launchCameraAsync: jest.fn() }))
jest.mock('@/lib/api', () => ({
  saveOnboardingStep: jest.fn(async () => ({ ok: true })),
  verifyGstinForOnboarding: jest.fn(async () => ({ ok: true, status: 200, data: { verified: true, autofill: { verified: true, active: true, legalName: 'Sharma & Co LLP', tradeName: 'Sharma & Co', state: 'TS', stateMismatch: false, registrationDate: '2020-01-01', statusText: null, address: null } } })),
  uploadCredentialDocument: jest.fn(async () => ({ ok: true, url: 'credentials/u/icai.pdf' })),
  verifyBankForOnboarding: jest.fn(async () => ({ ok: true, status: 200, data: { verified: true, accountHolderName: 'SHARMA AND CO LLP' } })),
  acceptLegalDocsMobile: jest.fn(async () => ({ ok: true, status: 200, data: {} })),
  submitProviderProfile: jest.fn(async () => ({ ok: true, status: 200, data: {} })),
}))

const next = async () => { fireEvent.press(screen.getByTestId('wizard-next')) }

describe('E13 FR-13.4 — native provider onboarding (D-PRD3)', () => {
  it('walks the four E10 steps and submits the same body as the web wizard', async () => {
    render(<I18nProvider><PartnerOnboardingScreen /></I18nProvider>)
    fireEvent.press(await screen.findByTestId('wizard-start', {}, { timeout: 5000 }))

    // Contact — each step is saved on the server (the stall nudge reads it).
    await screen.findByTestId('wizard-contact')
    await waitFor(() => expect(api.saveOnboardingStep).toHaveBeenCalledWith('contact', undefined))
    fireEvent.changeText(screen.getByLabelText('Your name'), 'Asha Sharma')
    await next()

    // Business — GSTIN first; the legal name comes from GST records and is locked.
    await screen.findByTestId('wizard-business')
    fireEvent.changeText(screen.getByLabelText('GSTIN'), '36AABCS1234C1ZY')
    fireEvent.press(screen.getByTestId('wizard-verify-gstin'))
    await screen.findByText('✓ Verified with GST records')
    expect(screen.getByLabelText('Legal name').props.editable).toBe(false)
    expect(screen.getByLabelText('Legal name').props.value).toBe('Sharma & Co LLP')
    fireEvent.press(screen.getByTestId('cat-tax-accounting'))
    await next()

    // Credentials & bank — tax needs a statutory credential (kind, number, document), then a verified account.
    await screen.findByTestId('wizard-credentials_bank')
    fireEvent.press(screen.getByText('Chartered Accountant (CA)'))
    fireEvent.changeText(screen.getByLabelText('Membership / registration number'), 'A123456')
    fireEvent.press(screen.getByText('Choose a file'))
    await screen.findByText('Uploaded: icai.pdf')
    fireEvent.changeText(screen.getByLabelText('Account number'), '123456789012')
    fireEvent.changeText(screen.getByLabelText('IFSC'), 'HDFC0000001')
    fireEvent.press(screen.getByTestId('wizard-verify-bank'))
    await screen.findByText('✓ Bank account verified')
    expect(screen.getByLabelText('Account holder').props.value).toBe('SHARMA AND CO LLP')
    await next()

    // Review → accept → submit through legal/accept then POST /profile/provider.
    await screen.findByTestId('wizard-review')
    expect(screen.getByText(/•••• 9012/)).toBeTruthy()
    fireEvent.press(screen.getByTestId('wizard-accept'))
    fireEvent.press(screen.getByTestId('wizard-submit'))
    await screen.findByTestId('wizard-done')
    expect(api.acceptLegalDocsMobile).toHaveBeenCalledWith(['terms', 'privacy', 'provider_addendum'], 'en')
    const body = (api.submitProviderProfile as jest.Mock).mock.calls[0][0]
    expect(body).toMatchObject({
      fullName: 'Asha Sharma', legalName: 'Sharma & Co LLP', displayName: 'Sharma & Co', gstin: '36AABCS1234C1ZY', state: 'TS',
      categorySlugs: ['tax-accounting'], bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: 'SHARMA AND CO LLP', bankVerified: true,
      credentialUploads: { 'tax-accounting': { url: 'credentials/u/icai.pdf', name: 'icai.pdf', kind: 'ca', number: 'A123456' } },
    })
  })

  it('a nudge link reopens the exact step (?step=)', async () => {
    const router = jest.requireMock('expo-router')
    router.useLocalSearchParams.mockReturnValueOnce({ step: 'business' })
    render(<I18nProvider><PartnerOnboardingScreen /></I18nProvider>)
    await screen.findByTestId('wizard-business', {}, { timeout: 5000 })
  })
})
