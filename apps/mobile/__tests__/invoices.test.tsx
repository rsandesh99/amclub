import { fireEvent, render, screen } from '@testing-library/react-native'
import { Linking } from 'react-native'
import { I18nProvider } from '@/lib/i18n'
import InvoicesScreen from '@/app/(app)/invoices'

jest.mock('@/lib/api', () => ({
  fetchMyInvoices: jest.fn(async () => ({
    ok: true,
    invoices: [
      { id: 'i1', number: 'INV-2026-0001', orderId: 'o1', orderNumber: 'AMC-1', orderTitle: 'GST returns', totalPaise: 354_000, createdAt: '2026-09-20T10:00:00Z', downloadUrl: 'https://signed.example/i1.pdf' },
      { id: 'i2', number: 'INV-2026-0002', orderId: 'o2', orderNumber: 'AMC-2', orderTitle: 'Audit', totalPaise: 100_000, createdAt: '2026-09-21T10:00:00Z', downloadUrl: null },
    ],
  })),
}))

describe('E13 Invoices', () => {
  it('lists the buyer invoices; the PDF opens the signed link; a pending PDF says so', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    render(<I18nProvider><InvoicesScreen /></I18nProvider>)
    await screen.findByTestId('invoices-v3', {}, { timeout: 5000 })
    expect(screen.getByText('INV-2026-0001')).toBeTruthy()
    expect(screen.getByText('Preparing…')).toBeTruthy()
    fireEvent.press(screen.getByText('PDF'))
    expect(open).toHaveBeenCalledWith('https://signed.example/i1.pdf')
  })
})
