import type { WaTemplateRegistry } from './template-types'

/**
 * ADR-030 §4 — templates for notification kinds added with the notification registry (refunds, reminders, dispute
 * outcomes, verification, pools …). Merged into WA_TEMPLATES by templates.ts. Owned by the notifications work.
 */
export const NOTIFY_TEMPLATES: WaTemplateRegistry = {}
