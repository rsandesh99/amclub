import { render, screen, within } from '@testing-library/react-native'
import { COMPANY_LINE } from '@amclub/shared'
import { I18nProvider } from '@/lib/i18n'
import HelpScreen from '@/app/(app)/help'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({ fetchMe: jest.fn() }))

describe('Help for everyone (audit §7)', () => {
  it('a user outside the assistant cohort gets contact, safety, settings and the grievance officer — no assistant chat', async () => {
    ;(api.fetchMe as jest.Mock).mockResolvedValue({ supportEnabled: false })
    render(<I18nProvider><HelpScreen /></I18nProvider>)
    await screen.findByTestId('help-screen', {}, { timeout: 5000 })
    expect(screen.getByTestId('help-whatsapp')).toBeTruthy()
    expect(screen.getByTestId('help-email')).toBeTruthy()
    expect(screen.getByTestId('help-safety')).toBeTruthy()
    expect(screen.getByTestId('help-privacy')).toBeTruthy()
    expect(screen.getByTestId('help-grievance')).toBeTruthy()
    expect(screen.getByText('Sandesh Reddy')).toBeTruthy()
    // One official number: with EXPO_PUBLIC_WHATSAPP_NUMBER unset it is the company line.
    expect(within(screen.getByTestId('help-whatsapp')).getByText(COMPANY_LINE.display)).toBeTruthy()
    expect(screen.queryByTestId('help-assistant')).toBeNull()
  })
  it('the assistant chat stays for the cohort', async () => {
    ;(api.fetchMe as jest.Mock).mockResolvedValue({ supportEnabled: true })
    render(<I18nProvider><HelpScreen /></I18nProvider>)
    expect(await screen.findByTestId('help-assistant', {}, { timeout: 5000 })).toBeTruthy()
  })
})
