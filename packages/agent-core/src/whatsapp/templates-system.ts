import type { WaTemplateRegistry } from './template-types'

/**
 * ADR-030 §2 — system templates the runtime sends on its own (opt-in / opt-out confirmation, the HELP menu, language
 * changed, data-request receipt). Merged into WA_TEMPLATES by templates.ts. Owned by the consent / dispatcher work.
 */
export const SYSTEM_TEMPLATES: WaTemplateRegistry = {}
