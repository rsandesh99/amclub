/**
 * Output schema for `photo_plausibility@v1` (schemaRef: photoPlausibilitySchema).
 * The contract lives in @amclub/shared (dossier.ts) because the web routes and
 * the verify script consume the same findings; this module re-exports it next
 * to the prompt, like prompts/hello/schema.ts, so the eval runner and the
 * runtime agent import the schema from where the prompt is.
 */
export {
  photoPlausibilitySchema,
  photoFindingSchema,
  photoFindingPasses,
  photoFindingFailures,
  PHOTO_CONFIDENCE_MIN,
  type PhotoPlausibility,
  type PhotoFinding,
} from '@amclub/shared'
