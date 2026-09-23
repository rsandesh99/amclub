import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerInsightsScreen from '@/app/(app)/partner-insights'
import * as api from '@/lib/api'

const payload = (medianPct: number | null) => ({
  range: '30d',
  weeks: [{ week: '2026-09-14', views: 10, matched: 4, quoted: 3, won: 1 }],
  loss: { price: { n: 6, of: 9, medianPct }, delivery: { n: 2, of: 9, medianDays: null } },
  declineReasons: [{ reason: 'price_high', n: 3 }],
  listings: [],
})
jest.mock('@/lib/api', () => ({ fetchPartnerInsights: jest.fn() }))

describe('E13 Insights (read-only)', () => {
  it('a median only when the server sends one; counts always; the range refetches', async () => {
    ;(api.fetchPartnerInsights as jest.Mock).mockResolvedValue(payload(12))
    render(<I18nProvider><PartnerInsightsScreen /></I18nProvider>)
    await screen.findByTestId('insights-v3', {}, { timeout: 5000 })
    expect(screen.getByText('Dearer in 6 of 9, by a median of 12%')).toBeTruthy()
    expect(screen.getByText('Slower than the chosen quote in 2 of 9')).toBeTruthy()
    expect(screen.getByText('Price too high · 3')).toBeTruthy()
    ;(api.fetchPartnerInsights as jest.Mock).mockResolvedValue(payload(null))
    fireEvent.press(screen.getByText('7 days'))
    await waitFor(() => expect(api.fetchPartnerInsights).toHaveBeenLastCalledWith('7d'))
    await screen.findByText('Dearer than the chosen quote in 6 of 9')
  })
})
