import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { I18nProvider } from '@/lib/i18n'
import PartnerProfileScreen from '@/app/(app)/partner-profile'
import * as api from '@/lib/api'

jest.mock('@/lib/api', () => ({
  API_URL: 'https://amclub.test',
  fetchMyAvailability: jest.fn(async () => ({ nextAvailableOn: null, capacitySlots: 5, displayName: 'Sharma & Co.', status: 'active' })),
  saveMyAvailability: jest.fn(async () => true),
}))

describe('E13 Profile & availability (N11)', () => {
  it('capacity steps within 1..50 and saves the shape the web route takes', async () => {
    render(<I18nProvider><PartnerProfileScreen /></I18nProvider>)
    await screen.findByTestId('provider-profile-v3', {}, { timeout: 5000 })
    expect(screen.getByText('Sharma & Co.')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('More'))
    fireEvent.press(screen.getByText('Save'))
    await waitFor(() => expect(api.saveMyAvailability).toHaveBeenCalledWith({ nextAvailableOn: null, capacitySlots: 6 }))
    await screen.findByText('Saved ✓')
  })
})
