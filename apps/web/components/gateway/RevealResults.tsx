'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Check,
  ChevronRight,
  IndianRupee,
  Lock,
  MessageCircle,
  ShieldCheck,
} from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { ResultCard } from '@/components/catalog/ResultCard'
import { Link } from '@/i18n/navigation'
import { RevealHeader } from './RevealHeader'
import { fetchGatewayResults, type GatewayResults } from './search'
import { catKey, BAND_KEY } from './constants'
import { saveBuyerDraft, type BuyerDraft } from './draft'
import type { AppLocale } from '@/i18n/routing'

interface RevealResultsProps {
  answers: BuyerDraft
  onStartOver: () => void
  onSelectLocale: (locale: AppLocale) => void
  track: (event: string, props?: Record<string, unknown>) => void
}

/**
 * Scene 4 — the site revealed beneath the card. Real matching: the grid is
 * the live catalog search filtered by the wizard's category + state
 * (verified-only, rating-sorted); the meta line's count is the response
 * total, and the escrow line is product fact — no invented stats (§Phase 8a).
 */
export function RevealResults({ answers, onStartOver, onSelectLocale, track }: RevealResultsProps) {
  const t = useTranslations('gateway')
  const router = useRouter()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const [data, setData] = useState<GatewayResults | null>(null)
  const [failed, setFailed] = useState(false)
  const [rfqOpen, setRfqOpen] = useState(false)
  const [rfqGate, setRfqGate] = useState(false)
  const [note, setNote] = useState(answers.note ?? '')

  useEffect(() => {
    let alive = true
    setFailed(false)
    fetchGatewayResults(answers.cat, answers.state)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [answers.cat, answers.state])

  const experts = answers.cat ? t(`expert_${catKey(answers.cat)}`) : t('all_services')
  const stateName = answers.state ? t(`state_${answers.state}`) : null
  const title = stateName ? t('serving', { experts, state: stateName }) : experts
  const hasDraft = Boolean(answers.cat || answers.state || answers.biz || answers.band)

  function scrollToList() {
    if (!scrollRef.current || !listRef.current) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scrollRef.current.scrollTo({
      top: listRef.current.offsetTop - 84,
      behavior: reduced ? 'auto' : 'smooth',
    })
  }

  function toggleRfq() {
    if (!rfqOpen) {
      track('gateway_rfq_opened', { category: answers.cat, state: answers.state, prefilled: true })
    }
    setRfqOpen((v) => !v)
  }

  function sendRfq() {
    track('gateway_rfq_submitted', { category: answers.cat, state: answers.state, prefilled: true })
    saveBuyerDraft({ ...answers, ...(note.trim() ? { note: note.trim() } : {}) })
    setRfqGate(true)
  }

  const actionCard =
    'flex min-h-16 w-full cursor-pointer items-center gap-3.5 rounded-card border bg-surface p-4 text-left font-sans text-foreground shadow-resting ' +
    'transition-[border-color,box-shadow,transform] duration-150 ease-out motion-safe:hover:-translate-y-px hover:shadow-hover motion-safe:active:scale-[0.98] ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2'

  return (
    <div ref={scrollRef} className="gw-fade-fast absolute inset-0 overflow-y-auto overscroll-contain bg-background">
      <RevealHeader onStartOver={onStartOver} onSelectLocale={onSelectLocale} />

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-[22px] px-4 pb-[88px] pt-6 sm:px-10 sm:pb-24 sm:pt-9">
        <div className="gw-rise" style={{ animationDelay: '100ms' }}>
          {hasDraft && (
            <div className="inline-flex items-center gap-1.5 rounded-chip bg-success-soft px-3 py-1 text-[12.5px] font-medium text-success">
              <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
              {t('saved_note')}
            </div>
          )}
          <h1 className="mb-0 mt-3 font-display text-[26px] font-extrabold leading-[1.2] tracking-[-0.02em] text-foreground [text-wrap:pretty] sm:text-[34px] sm:leading-[1.15]">
            {title}
          </h1>
          <div className="mt-2 flex items-start gap-1.5 text-sm leading-[1.45] text-foreground-secondary">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {data ? t('results_meta', { count: data.total }) : t('results_loading')}
            </span>
          </div>
          {data?.widened && (
            <div className="mt-2 text-[13px] text-warning">{t('results_from_state')}</div>
          )}
        </div>

        <div className="gw-rise grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-3.5" style={{ animationDelay: '200ms' }}>
          <button type="button" onClick={scrollToList} className={`${actionCard} border-border`}>
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-button bg-primary-soft text-primary">
              <IndianRupee className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-[17px] font-semibold leading-snug [text-wrap:pretty]">{t('act_book')}</span>
              <span className="text-[13.5px] leading-[1.4] text-foreground-secondary">{t('act_book_sub')}</span>
            </span>
            <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-foreground-secondary" aria-hidden />
          </button>

          <button
            type="button"
            onClick={toggleRfq}
            className={actionCard}
            style={{
              borderColor: rfqOpen
                ? 'color-mix(in srgb, var(--primary) 45%, var(--border))'
                : 'var(--border)',
            }}
          >
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-button bg-primary-soft text-primary">
              <MessageCircle className="h-[22px] w-[22px]" aria-hidden />
            </span>
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-[17px] font-semibold leading-snug [text-wrap:pretty]">{t('act_quote')}</span>
              <span className="text-[13.5px] leading-[1.4] text-foreground-secondary">{t('act_quote_sub')}</span>
            </span>
            <ChevronRight className="ml-auto h-5 w-5 shrink-0 text-foreground-secondary" aria-hidden />
          </button>
        </div>

        {rfqOpen && (
          <div className="gw-rise-xs rounded-[14px] border border-border bg-surface px-4 py-5 shadow-resting sm:px-[22px]">
            {!rfqGate ? (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="m-0 font-display text-[21px] font-extrabold tracking-[-0.015em] text-foreground">
                    {t('rfq_title')}
                  </h2>
                  <span
                    className="inline-flex items-center gap-1.5 rounded-chip border bg-verified-soft px-3 py-1 text-[12.5px] font-medium text-verified"
                    style={{ borderColor: 'color-mix(in srgb, var(--verified) 30%, transparent)' }}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                    {t('rfq_pref')}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {answers.cat && (
                    <span className="rounded-chip bg-primary-soft px-3.5 py-1.5 text-sm font-semibold text-primary">
                      {t(`need_${catKey(answers.cat)}`)}
                    </span>
                  )}
                  {answers.state && (
                    <span className="rounded-chip bg-primary-soft px-3.5 py-1.5 text-sm font-semibold text-primary">
                      {t(`state_${answers.state}`)}
                    </span>
                  )}
                  {answers.biz && (
                    <span className="rounded-chip bg-muted px-3.5 py-1.5 text-sm font-medium text-foreground">
                      {t(`biz_${answers.biz}`)}
                    </span>
                  )}
                  {answers.band && (
                    <span className="rounded-chip bg-muted px-3.5 py-1.5 text-sm font-medium text-foreground">
                      {t(BAND_KEY[answers.band])}
                    </span>
                  )}
                </div>
                <textarea
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  aria-label={t('rfq_title')}
                  placeholder={t('rfq_ph')}
                  className="w-full resize-none rounded-button border border-border bg-surface px-3.5 py-3 font-sans text-base leading-normal text-foreground placeholder:text-foreground-secondary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/25"
                />
                <button
                  type="button"
                  onClick={sendRfq}
                  className="inline-flex min-h-11 items-center gap-2 self-start rounded-button bg-primary px-5 py-2.5 font-sans text-base font-semibold text-white transition-colors hover:bg-primary-strong motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  {t('rfq_send')}
                </button>
              </div>
            ) : (
              <div className="gw-rise-xs flex flex-col gap-3.5 sm:flex-row sm:items-center">
                <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-chip bg-success-soft text-success">
                  <Check className="h-6 w-6" strokeWidth={2.5} aria-hidden />
                </span>
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="font-display text-[19px] font-extrabold text-foreground">
                    {t('rfq_sent_title')}
                  </span>
                  <span className="text-sm leading-[1.45] text-foreground-secondary [text-wrap:pretty]">
                    {t('rfq_sent_sub')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => router.push('/signup')}
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 self-start rounded-button bg-primary px-5 py-2.5 font-sans text-base font-semibold text-white transition-colors hover:bg-primary-strong motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:self-center"
                >
                  {t('rfq_signup_cta')}
                </button>
              </div>
            )}
          </div>
        )}

        <div ref={listRef} className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
          {data?.results.map((r, i) => (
            <div key={r.packageId} className="gw-rise" style={{ animationDelay: `${300 + i * 60}ms` }}>
              <ResultCard result={r} />
            </div>
          ))}
        </div>

        {(failed || (data && data.results.length === 0)) && (
          <div className="gw-rise flex flex-col items-start gap-2 rounded-card border border-border bg-surface p-6" style={{ animationDelay: '300ms' }}>
            <h2 className="m-0 font-display text-lg font-bold text-foreground">
              {t('results_empty_title')}
            </h2>
            <p className="m-0 text-sm text-foreground-secondary">{t('results_empty_sub')}</p>
            <Link
              href="/services"
              className="mt-2 inline-flex min-h-11 items-center rounded-button bg-primary px-5 py-2.5 text-base font-semibold text-white transition-colors hover:bg-primary-strong"
            >
              {t('browse_all')}
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}
