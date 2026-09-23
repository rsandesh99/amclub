import { fireEvent, render, screen } from '@testing-library/react-native'
import { router } from 'expo-router'
import { I18nProvider } from '@/lib/i18n'
import ProfileScreen from '@/app/(app)/profile'
import * as api from '@/lib/api'
import { currentMobileRole, setMobileRole } from '@/lib/role'

jest.mock('@/lib/api', () => ({ fetchMe: jest.fn() }))

describe('E13 Profile sheet', () => {
  it('an account with both sides switches from buyer to provider and lands on Today', async () => {
    ;(api.fetchMe as jest.Mock).mockResolvedValue({ fullName: 'Asha', roles: ['msme', 'provider'], hasMsmeProfile: true, hasProviderProfile: true })
    setMobileRole('buyer')
    render(<I18nProvider><ProfileScreen /></I18nProvider>)
    await screen.findByTestId('profile-v3', {}, { timeout: 5000 })
    expect(screen.getByTestId('profile-invoices')).toBeTruthy()
    fireEvent.press(screen.getByTestId('role-provider'))
    expect(currentMobileRole()).toBe('provider')
    expect(router.replace).toHaveBeenCalledWith('/partner')
  })
  it('a buyer-only account sees no switch', async () => {
    ;(api.fetchMe as jest.Mock).mockResolvedValue({ fullName: 'Ravi', roles: ['msme'], hasMsmeProfile: true, hasProviderProfile: false })
    setMobileRole('buyer')
    render(<I18nProvider><ProfileScreen /></I18nProvider>)
    await screen.findByTestId('profile-v3', {}, { timeout: 5000 })
    expect(screen.queryByTestId('role-provider')).toBeNull()
  })
})
