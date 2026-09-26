import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import WhatsAppSettingsScreen from '@/app/(app)/whatsapp-settings'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({ fetchWhatsAppConsent: jest.fn(), updateWhatsAppConsent: jest.fn() }))

const STATE = {
  phoneMasked: '••••••5455',
  purposes: { transactional: 'none', assistant: 'none', marketing: 'none' },
  suppressed: null,
  noticeVersion: 'wa-2026-09-26',
  businessNumber: null,
}

describe('Settings → WhatsApp (mobile)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('before the migration it says "coming soon", not an error', async () => {
    ;(api.fetchWhatsAppConsent as jest.Mock).mockResolvedValue({ kind: 'not_ready' })
    render(<I18nProvider><WhatsAppSettingsScreen /></I18nProvider>)
    expect(await screen.findByTestId('wa-not-ready', {}, { timeout: 5000 })).toBeTruthy()
  })

  it('shows the masked number and one switch per purpose; marketing stays hidden', async () => {
    ;(api.fetchWhatsAppConsent as jest.Mock).mockResolvedValue({ kind: 'ready', data: STATE })
    render(<I18nProvider><WhatsAppSettingsScreen /></I18nProvider>)
    await screen.findByTestId('wa-purpose-transactional', {}, { timeout: 5000 })
    expect(screen.getByText('Your number: ••••••5455')).toBeTruthy()
    expect(screen.getByTestId('wa-purpose-assistant')).toBeTruthy()
    expect(screen.queryByTestId('wa-purpose-marketing')).toBeNull()
  })

  it('turning order updates on records the transactional opt-in; turning it off is one tap', async () => {
    ;(api.fetchWhatsAppConsent as jest.Mock).mockResolvedValue({ kind: 'ready', data: STATE })
    const on = { ...STATE, purposes: { ...STATE.purposes, transactional: 'opted_in' } }
    ;(api.updateWhatsAppConsent as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, error: null, state: on })
    render(<I18nProvider><WhatsAppSettingsScreen /></I18nProvider>)
    const sw = await screen.findByTestId('wa-switch-transactional', {}, { timeout: 5000 })
    fireEvent(sw, 'valueChange', true)
    await waitFor(() => expect(api.updateWhatsAppConsent).toHaveBeenCalledWith('transactional', true))
    await screen.findByText("Turned on. We'll message you on WhatsApp.")

    ;(api.updateWhatsAppConsent as jest.Mock).mockResolvedValueOnce({ ok: true, status: 200, error: null, state: STATE })
    fireEvent(screen.getByTestId('wa-switch-transactional'), 'valueChange', false)
    await waitFor(() => expect(api.updateWhatsAppConsent).toHaveBeenLastCalledWith('transactional', false))
  })

  it('a marketing opt-in already on is shown so it can be turned off', async () => {
    ;(api.fetchWhatsAppConsent as jest.Mock).mockResolvedValue({ kind: 'ready', data: { ...STATE, purposes: { ...STATE.purposes, marketing: 'opted_in' } } })
    render(<I18nProvider><WhatsAppSettingsScreen /></I18nProvider>)
    expect(await screen.findByTestId('wa-purpose-marketing', {}, { timeout: 5000 })).toBeTruthy()
  })
})
