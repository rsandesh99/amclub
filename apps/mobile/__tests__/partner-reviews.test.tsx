import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerReviewsScreen from '@/app/(app)/partner-reviews'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({
  fetchMyReviews: jest.fn(async () => ({
    ok: true, avgRating: 4.5, reviewCount: 2,
    reviews: [
      { id: 'r1', rating: 5, text: 'Great work', provider_reply: null, status: 'published', created_at: '2026-09-20T10:00:00Z', order: { order_number: 'AMC-1', title: 'GST returns' } },
      { id: 'r2', rating: 4, text: 'Good', provider_reply: 'Thank you', status: 'published', created_at: '2026-09-19T10:00:00Z', order: null },
    ],
  })),
  replyReview: jest.fn(async () => ({ ok: true, data: {} })),
}))

describe('E13 Reviews', () => {
  it('shows the summary and each review; one reply box for the unanswered one; replying posts once', async () => {
    render(<I18nProvider><PartnerReviewsScreen /></I18nProvider>)
    await screen.findByTestId('reviews-v3', {}, { timeout: 5000 })
    expect(screen.getByText('4.5 average from 2 reviews')).toBeTruthy()
    expect(screen.getAllByLabelText('Write a public reply…')).toHaveLength(1)
    fireEvent.changeText(screen.getByLabelText('Write a public reply…'), 'Thanks!')
    fireEvent.press(screen.getByText('Reply'))
    await waitFor(() => expect(api.replyReview).toHaveBeenCalledWith('r1', 'Thanks!'))
    await screen.findByText('Thanks!')
    expect(screen.queryAllByLabelText('Write a public reply…')).toHaveLength(0)
  })
})
