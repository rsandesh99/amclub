/**
 * Output schema for `rfq_clarify@v1` (schemaRef: clarifyQuestionSchema). The
 * contract, the per-gap keyword lists, the script ranges and the keyless stub
 * live in @amclub/shared (schemas/index.ts + intake-rules.ts): the voice-parse
 * route, the eval and the rig consume the same objects.
 */
export {
  clarifyQuestionSchema,
  CLARIFY_GAP_KEYWORDS,
  CLARIFY_SCRIPT_RE,
  clarifyLocaleFor,
  needsClarification,
  stubClarifyQuestion,
  type ClarifyQuestion,
} from '@amclub/shared'
