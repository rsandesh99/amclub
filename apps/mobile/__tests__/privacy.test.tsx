import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PrivacyScreen from '@/app/(app)/privacy'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({ fetchPrivacyRequests: jest.fn(), createPrivacyRequest: jest.fn() }))

describe('Privacy requests (mobile, DPDP)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('a correction needs details before anything is sent', async () => {
    ;(api.fetchPrivacyRequests as jest.Mock).mockResolvedValue({ kind: 'ready', data: [] })
    render(<I18nProvider><PrivacyScreen /></I18nProvider>)
    fireEvent.press(await screen.findByTestId('privacy-kind-correction', {}, { timeout: 5000 }))
    fireEvent.press(screen.getByTestId('privacy-submit'))
    expect(await screen.findByText('Please add a few words (at least 10 characters) so we know what to do.')).toBeTruthy()
    expect(api.createPrivacyRequest).not.toHaveBeenCalled()
  })

  it('an access request is filed and listed with its due date', async () => {
    ;(api.fetchPrivacyRequests as jest.Mock).mockResolvedValue({ kind: 'ready', data: [] })
    const request = { id: 'r1', kind: 'access', status: 'open', details: null, resolution: null, dueAt: '2026-10-26T10:00:00.000Z', createdAt: '2026-09-26T10:00:00.000Z', resolvedAt: null }
    ;(api.createPrivacyRequest as jest.Mock).mockResolvedValue({ ok: true, status: 201, error: null, request, dueAt: null })
    render(<I18nProvider><PrivacyScreen /></I18nProvider>)
    fireEvent.press(await screen.findByTestId('privacy-submit', {}, { timeout: 5000 }))
    await waitFor(() => expect(api.createPrivacyRequest).toHaveBeenCalledWith('access', null))
    expect(await screen.findByTestId('privacy-request-row')).toBeTruthy()
  })

  it('before the migration it says "coming soon" and hides the form', async () => {
    ;(api.fetchPrivacyRequests as jest.Mock).mockResolvedValue({ kind: 'not_ready' })
    render(<I18nProvider><PrivacyScreen /></I18nProvider>)
    expect(await screen.findByTestId('privacy-not-ready', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByTestId('privacy-submit')).toBeNull()
  })
})
