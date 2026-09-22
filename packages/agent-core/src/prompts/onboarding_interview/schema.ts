import { onboardingDraftSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `onboarding_interview@v1`. S2.1: the draft becomes the
 * provider's public profile and packages — no contact details in the prose
 * (the wizard collects phone / email itself), no payment instruction, no URL,
 * no approval / verification claim (the agent never verifies). A violation
 * rejects the draft and the interview asks again (the S1.6 revise path).
 */
export const onboardingDraftSchema = customerFacingText(bare, {
  fields: ['profile.about', 'profile.display_name', 'profile.legal_name', 'packages[].title', 'packages[].scope_included[]', 'packages[].deliverables[]'],
  forbid: ['contact', 'payment', 'urls', 'approval'],
})
export {
  onboardingDraftPackageSchema,
  onboardingDraftProfileSchema,
  capabilityFactsFromDraft,
  type OnboardingDraft,
  type OnboardingDraftPackage,
} from '@amclub/shared'
