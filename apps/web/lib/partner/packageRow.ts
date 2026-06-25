import type { PackageInput } from '@amclub/shared'

export function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}

/** Build the stored package row from validated input (shared by create/edit). */
export function toPackageRow(d: PackageInput, categoryId: string) {
  return {
    category_id: categoryId,
    title_i18n: { en: d.title, hi: d.title },
    scope_included: d.scope_included,
    scope_excluded: d.scope_excluded ?? [],
    deliverables: d.deliverables,
    requirements_template: {
      fields: (d.requirements ?? []).map((label, i) => ({
        name: `req_${i}`,
        type: 'textarea',
        label_en: label,
        required: true,
      })),
    },
    price_paise: d.price_paise,
    discount_bps: d.discount_bps,
    member_extra_discount_bps: d.member_extra_discount_bps,
    delivery_days: d.delivery_days,
    revision_count: d.revision_count,
    faqs: (d.faqs ?? []).map((f) => ({ q: f.question, a: f.answer })),
    status: d.status,
  }
}
