/**
 * Output schema for `onboarding_interview@v1` (schemaRef: onboardingDraftSchema).
 * The contract lives in @amclub/shared (onboarding.ts) because the runtime, the
 * web routes, the rig and the eval consume it; re-exported next to the prompt so
 * the registry resolves it in one place (same pattern as rfq_quality/schema.ts).
 * Every object is `.strict()`: a verification / approval / status key the model
 * adds is rejected before anything is stored.
 */
export {
  onboardingDraftSchema,
  onboardingDraftPackageSchema,
  onboardingDraftProfileSchema,
  capabilityFactsFromDraft,
  type OnboardingDraft,
  type OnboardingDraftPackage,
} from '@amclub/shared'
