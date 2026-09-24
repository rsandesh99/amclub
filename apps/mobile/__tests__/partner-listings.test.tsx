import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerListingsScreen from '@/app/(app)/partner-listings'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({
  API_URL: 'https://amclub.test',
  fetchMyListings: jest.fn(async () => ({
    ok: true,
    listings: [
      { id: 'l1', slug: 'gst', providerSlug: 'p', title: 'GST returns', status: 'active', pricePaise: 250_000, discountBps: 1000, deliveryDays: 4, categorySlug: 'tax', categoryName: 'Tax' },
      { id: 'l2', slug: 'draft', providerSlug: 'p', title: 'Draft one', status: 'draft', pricePaise: 100_000, discountBps: 0, deliveryDays: null, categorySlug: null, categoryName: null },
    ],
  })),
  setListingStatus: jest.fn(async () => true),
}))

describe('E13 Listings', () => {
  it('shows each listing with status and stored price; pause goes through the status route; drafts have no toggle', async () => {
    render(<I18nProvider><PartnerListingsScreen /></I18nProvider>)
    await screen.findByTestId('listings-v3', {}, { timeout: 5000 })
    expect(screen.getByText('GST returns')).toBeTruthy()
    expect(screen.getByText('Live')).toBeTruthy()
    expect(screen.getByText('Draft')).toBeTruthy()
    expect(screen.getAllByText('Pause')).toHaveLength(1)
    fireEvent.press(screen.getByText('Pause'))
    await waitFor(() => expect(api.setListingStatus).toHaveBeenCalledWith('l1', 'paused'))
    await screen.findByText('Resume')
    expect(screen.getByText('Paused')).toBeTruthy()
  })
  it('"Edit on web" opens the web editor for that listing', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    render(<I18nProvider><PartnerListingsScreen /></I18nProvider>)
    await screen.findByTestId('listings-v3', {}, { timeout: 5000 })
    fireEvent.press(screen.getAllByText('Edit on web')[0]!)
    expect(open).toHaveBeenCalledWith('https://amclub.test/partner/listings/l1/edit')
  })
})
