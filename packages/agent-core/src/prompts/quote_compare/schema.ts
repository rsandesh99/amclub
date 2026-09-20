/**
 * Output schema for `quote_compare@v1` (schemaRef: comparePointersSchema). The
 * contract lives in @amclub/shared (compare-pointers.ts): strict object, no
 * rank / recommendation / best field; the banned-phrase gate is exported from
 * the same module. Re-exported next to the prompt (the S1.1 pattern).
 */
export {
  comparePointersSchema,
  comparePointersCacheSchema,
  COMPARE_BANNED_PHRASES,
  findBannedPhrases,
  sanitizePointers,
  type ComparePointers,
  type ComparePointersCache,
  type PointerLocale,
} from '@amclub/shared'
