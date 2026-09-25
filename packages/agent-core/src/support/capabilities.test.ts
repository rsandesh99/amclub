import { describe, expect, it } from 'vitest'
import { isSupportCapabilitiesQuestion } from './capabilities'

describe('isSupportCapabilitiesQuestion', () => {
  it('matches questions about what the assistant can do, in en / hi / te / ta', () => {
    for (const t of [
      'What can you help me with?',
      'what can you do',
      'How can you help me?',
      'what do you do',
      'Hi, what all can you help with?',
      'what are you able to do',
      'who are you?',
      'What can I ask?',
      'help',
      'Help?',
      'menu',
      'आप क्या मदद कर सकते हैं?',
      'आप क्या कर सकते हैं',
      'मदद',
      'aap kya madad kar sakte ho',
      'kis cheez mein help kar sakte ho',
      'మీరు ఏమి సహాయం చేయగలరు?',
      'నీవు ఏం చేయగలవు',
      'நீங்கள் என்ன உதவி செய்ய முடியும்?',
      'என்ன செய்ய முடியும்',
    ]) expect(isSupportCapabilitiesQuestion(t), t).toBe(true)
  })
  it('leaves everything else alone', () => {
    for (const t of [
      '',
      'asdkjh qwe',
      'the thing with the stuff',
      'what is the weather in Guntur today',
      'Where is my order?',
      'I need help filing GST',
      'helpful provider, thanks',
      'x'.repeat(200) + ' what can you do',
    ]) expect(isSupportCapabilitiesQuestion(t), t).toBe(false)
  })
})
