import { AccessibilityInfo, Text } from 'react-native'
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { GoldStamp } from '@/components/motion/GoldStamp'
import { PaisaMoment } from '@/components/motion/PaisaMoment'
import { Sheet } from '@/components/ui/Sheet'

describe('E13 FR-13.5 — signature motion + sheet', () => {
  it('Gold Stamp lands at once under reduced motion and reports done', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true)
    const onDone = jest.fn()
    render(<GoldStamp label="Accepted" onDone={onDone} />)
    expect(screen.getByLabelText('Accepted')).toBeTruthy()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('Paisa Moment shows the server amount text and hands back under reduced motion', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValueOnce(true)
    const onDone = jest.fn()
    render(<PaisaMoment visible title="Paid" amountText="₹1,180.00" onDone={onDone} />)
    expect(screen.getByText('₹1,180.00')).toBeTruthy()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 2000 })
  })

  it('Sheet renders its title and content; the backdrop dismisses', () => {
    const onClose = jest.fn()
    render(<Sheet visible title="Pick a state" onClose={onClose}><Text>Telangana</Text></Sheet>)
    expect(screen.getByText('Pick a state')).toBeTruthy()
    expect(screen.getByText('Telangana')).toBeTruthy()
    fireEvent.press(screen.getByLabelText('Pick a state', { exact: true }))
    expect(onClose).toHaveBeenCalled()
  })
})
