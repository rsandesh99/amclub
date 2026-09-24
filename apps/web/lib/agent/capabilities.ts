import type { AgentName, AgentPersona } from '@amclub/shared'

/**
 * The assistant's capabilities in the words a buyer or provider uses (the
 * assistant home and the corner launcher). Each maps to the switch that turns
 * it on for a person (`agent`, read through agentAvailability) or is always
 * there (`agent: null`). Copy lives in `assistant_home.cap.<key>`.
 */
export interface AssistantCapability {
  key: string
  agent: AgentName | null
  icon: 'mic' | 'file' | 'check' | 'columns' | 'gauge' | 'mail' | 'help' | 'whatsapp' | 'users' | 'camera' | 'notebook' | 'languages'
  /** Where to try it, when it has a page of its own. */
  href?: string
}

export const BUYER_CAPABILITIES: readonly AssistantCapability[] = [
  { key: 'voice_rfq', agent: null, icon: 'mic', href: '/app/rfq/new?entry=assistant' },
  { key: 'document_intake', agent: 'document_intake', icon: 'file', href: '/app/rfq/new?entry=assistant' },
  { key: 'rfq_quality', agent: 'rfq_quality', icon: 'check' },
  { key: 'compare', agent: 'compare_pointers', icon: 'columns', href: '/app/rfq' },
  { key: 'benchmark', agent: 'benchmark', icon: 'gauge' },
  { key: 'decline_message', agent: 'decline_message', icon: 'mail' },
  { key: 'support', agent: 'support', icon: 'help', href: '/app/support' },
  { key: 'procurement', agent: 'procurement', icon: 'whatsapp', href: '/app/assistant' },
  { key: 'pools', agent: 'demand_aggregation', icon: 'users' },
]

export const PROVIDER_CAPABILITIES: readonly AssistantCapability[] = [
  { key: 'munshi', agent: 'munshi', icon: 'notebook', href: '/partner/munshi' },
  { key: 'quote_extract', agent: 'quote_extract', icon: 'mic', href: '/partner/rfqs' },
  { key: 'onboarding', agent: 'onboarding', icon: 'whatsapp' },
  { key: 'content_translate', agent: 'content_translate', icon: 'languages', href: '/partner/listings' },
  { key: 'provider_support', agent: 'support', icon: 'help', href: '/partner/support' },
  { key: 'provider_pools', agent: 'demand_aggregation', icon: 'users', href: '/partner/pools' },
]

export function capabilitiesFor(persona: Extract<AgentPersona, 'buyer' | 'provider'>): readonly AssistantCapability[] {
  return persona === 'buyer' ? BUYER_CAPABILITIES : PROVIDER_CAPABILITIES
}

/** The actions a person must confirm each time, in plain words (`assistant_home.asks.<key>`). */
export const ASKS_FIRST: Record<'buyer' | 'provider', readonly string[]> = {
  buyer: ['send_requirement', 'accept_or_pay', 'decline', 'message', 'dispute', 'nudge'],
  provider: ['send_quote', 'revise_quote', 'message', 'confirm_profile', 'nudge'],
}

/** What the assistant never does (`assistant_home.never.<key>`). */
export const NEVER: Record<'buyer' | 'provider', readonly string[]> = {
  buyer: ['pay_alone', 'share_contact', 'bargain', 'see_others', 'after_off'],
  provider: ['send_alone', 'share_contact', 'bargain', 'see_others', 'after_off'],
}
