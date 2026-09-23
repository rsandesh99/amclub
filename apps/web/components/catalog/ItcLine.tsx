'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { formatINRExact } from '@/lib/format'

// One request per page load, shared by every price block on the page.
let eligibility: Promise<boolean> | null = null
function fetchEligibility(): Promise<boolean> {
  eligibility ??= fetch('/api/v1/me/itc', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { eligible: false }))
    .then((j: { eligible?: boolean }) => j.eligible === true)
    .catch(() => false)
  return eligibility
}

/**
 * N16 — "· claim ₹269.82 as ITC" for a buyer with a verified GSTIN. Public
 * pages are cached for everyone, so the viewer's eligibility is asked here;
 * the amount is the server's GST figure, never computed on the client.
 */
export function ItcLine({ gstPaise, known }: { gstPaise: number; known: boolean }) {
  const t = useTranslations('catalog')
  const [eligible, setEligible] = useState(known)
  useEffect(() => {
    if (known) return
    let live = true
    void fetchEligibility().then((e) => { if (live) setEligible(e) })
    return () => { live = false }
  }, [known])
  if (!eligible) return null
  return <span data-testid="itc-line">{t('itc_claim', { amount: formatINRExact(gstPaise) })}</span>
}
