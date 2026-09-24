import { render, screen } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerEarningsScreen from '@/app/(app)/partner-earnings'

jest.mock('@/lib/api', () => ({
  fetchMyPayouts: jest.fn(async () => ({
    ok: true,
    payouts: [
      { id: 'p1', orderId: 'o1', orderNumber: 'AMC-1', orderTitle: 'GST returns', amountPaise: 270_000, status: 'scheduled', scheduledFor: '2026-10-05', paidAt: null, holdReasons: [] },
      { id: 'p2', orderId: 'o2', orderNumber: 'AMC-2', orderTitle: 'Audit', amountPaise: 90_000, status: 'held', scheduledFor: null, paidAt: null, holdReasons: ['dispute_open', 'dispute_open'] },
      { id: 'p3', orderId: 'o3', orderNumber: 'AMC-3', orderTitle: 'ITR', amountPaise: 45_000, status: 'paid', scheduledFor: null, paidAt: '2026-09-20T10:00:00Z', holdReasons: [] },
    ],
  })),
}))

describe('E13 Earnings', () => {
  it('groups the ledger: scheduled · on hold (with the reason, once) · paid — server paise as sent', async () => {
    render(<I18nProvider><PartnerEarningsScreen /></I18nProvider>)
    await screen.findByTestId('earnings-v3', {}, { timeout: 5000 })
    expect(screen.getByText('Scheduled · 1')).toBeTruthy()
    expect(screen.getByText('On hold · 1')).toBeTruthy()
    expect(screen.getByText('Paid · 1')).toBeTruthy()
    expect(screen.getByText('₹2,700')).toBeTruthy()
    expect(screen.getByText(/Scheduled for/)).toBeTruthy()
    const held = screen.getByText(/^On hold: /)
    expect(held.props.children.split('·').length).toBe(1)
  })
})
