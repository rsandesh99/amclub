'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { usePathname, useRouter } from '@/i18n/navigation'
import { credentialOptionsForCategory } from '@amclub/shared'
import { useCardTilt } from './useCardTilt'
import { IntroDoors } from './IntroDoors'
import { WizardBuyer } from './WizardBuyer'
import { WizardProvider } from './WizardProvider'
import { RevealResults } from './RevealResults'
import { RevealPartner } from './RevealPartner'
import { LanguageChips } from './LanguageChips'
import { fetchGatewayResults } from './search'
import {
  clearGatewayPos,
  loadBuyerDraft,
  loadGatewayPos,
  loadProviderDraft,
  saveBuyerDraft,
  saveGatewayPos,
  saveProviderDraft,
  type BuyerDraft,
  type ProviderDraft,
} from './draft'
import type { AppLocale } from '@/i18n/routing'

/**
 * Phase 8a gateway `/` — single white card morphing through the handoff's
 * phase machine on a deep-green stage:
 *
 *   intro → (flood 400ms) → wizard  → exiting(450ms) → reveal   (buyer)
 *                         ↘ partner → pexiting(450ms) → preveal (provider)
 *
 * All timings/easings verbatim from the reference CSS; motion collapses under
 * prefers-reduced-motion (see .gw-stage rules in globals.css).
 */
type Phase = 'intro' | 'wizard' | 'partner' | 'exiting' | 'reveal' | 'pexiting' | 'preveal'

interface Flood {
  x: string
  y: string
  color: string
  on: boolean
}

export function Gateway() {
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()
  const posthog = useAnalytics()

  const [phase, setPhase] = useState<Phase>('intro')
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<string | null>(null)
  const [flood, setFlood] = useState<Flood | null>(null)
  const [buyer, setBuyer] = useState<BuyerDraft>({})
  const [provider, setProvider] = useState<ProviderDraft>({})
  // Skip the entrance replay when restoring mid-flow (e.g. after a locale switch).
  const [restored, setRestored] = useState(false)

  // Latest answers for callbacks that fire after a 250–450ms timeout — the
  // closure they were created in is one answer behind by then.
  const buyerRef = useRef(buyer)
  buyerRef.current = buyer

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const arm = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(fn, ms)
  }

  const tiltEnabled = phase === 'intro' || phase === 'wizard' || phase === 'partner'
  const { cardRef, onStageMouseMove, onStageMouseLeave } = useCardTilt(tiltEnabled)

  const track = useCallback(
    (event: string, props?: Record<string, unknown>) => {
      posthog.capture(event, { locale, device: 'web', role: 'anonymous', ...props })
    },
    [posthog, locale],
  )

  // ── Mount: rehydrate drafts, restore position (locale switch), first event ──
  useEffect(() => {
    const b = loadBuyerDraft()
    if (b) setBuyer(b)
    const p = loadProviderDraft()
    if (p) setProvider(p)

    const pos = loadGatewayPos()
    if (pos) {
      setRestored(true)
      if (pos.screen === 'results') setPhase('reveal')
      else if (pos.screen === 'apply') setPhase('preveal')
      else {
        setPhase(pos.door === 'msme' ? 'wizard' : 'partner')
        setStep(pos.step ?? 0)
      }
    }
    track('gateway_viewed')
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Locale switch — stash position so the navigation lands back here ──────
  function selectLocale(next: AppLocale) {
    if (next === locale) return
    track('language_switched', { to: next, surface: 'gateway' })
    router.replace(pathname, { locale: next })
  }

  // ── Door pick → color-flood → wizard ──────────────────────────────────────
  function pickDoor(door: 'msme' | 'provider', e: React.MouseEvent) {
    track('gateway_door_chosen', { door })
    track('gateway_wizard_step_viewed', { door, step: 1 })

    let x = '50%'
    let y = '60%'
    if (cardRef.current && e.clientX) {
      const r = cardRef.current.getBoundingClientRect()
      x = `${e.clientX - r.left}px`
      y = `${e.clientY - r.top}px`
    }
    const color = door === 'msme' ? 'var(--primary)' : '#ffffff'
    const next: Phase = door === 'msme' ? 'wizard' : 'partner'
    setFlood({ x, y, color, on: true })
    saveGatewayPos({ door, screen: 'wizard', step: 0 })
    arm(() => {
      setPhase(next)
      setStep(0)
      setPicked(null)
      setFlood({ x, y, color, on: false })
      arm(() => setFlood(null), 350)
    }, 400)
  }

  // ── Buyer wizard ───────────────────────────────────────────────────────────
  function answerBuyer(field: 'biz' | 'cat' | 'band' | 'state', value: string) {
    if (picked) return
    const answers = { ...buyer, [field]: value } as BuyerDraft
    setBuyer(answers)
    saveBuyerDraft(answers)
    track('gateway_wizard_step_answered', { door: 'msme', step: step + 1, field, value })
    // Fire the search as soon as the category is known — steps 3–4 plus the
    // reveal transition hide the latency entirely.
    if (field === 'cat') void fetchGatewayResults(value, answers.state).catch(() => {})
    if (field === 'state') void fetchGatewayResults(answers.cat, value).catch(() => {})
    setPicked(value)
    arm(() => {
      if (step < 3) {
        track('gateway_wizard_step_viewed', { door: 'msme', step: step + 2 })
        saveGatewayPos({ door: 'msme', screen: 'wizard', step: step + 1 })
        setStep(step + 1)
        setPicked(null)
      } else {
        track('gateway_wizard_completed', { door: 'msme', ...answers })
        reveal()
      }
    }, 250)
  }

  function reveal() {
    saveGatewayPos({ door: 'msme', screen: 'results' })
    setPhase('exiting')
    setPicked(null)
    arm(() => {
      setPhase('reveal')
      const a = buyerRef.current
      track('gateway_results_viewed', { category: a.cat, state: a.state })
    }, 450)
  }

  function skipWizard() {
    track('gateway_wizard_step_skipped', { door: 'msme', step: step + 1 })
    reveal()
  }

  // ── Provider wizard ────────────────────────────────────────────────────────
  function answerProvider(field: 'cat' | 'cred' | 'exp' | 'state', value: string) {
    if (picked) return
    const answers = { ...provider, [field]: value } as ProviderDraft
    // Changing category invalidates a previously picked credential — the new
    // category's step-1 options may not include it.
    if (field === 'cat' && answers.cred && !credentialOptionsForCategory(value).includes(answers.cred)) {
      delete answers.cred
    }
    setProvider(answers)
    saveProviderDraft(answers)
    track('gateway_wizard_step_answered', { door: 'provider', step: step + 1, field, value })
    setPicked(value)
    arm(() => {
      if (step < 3) {
        track('gateway_wizard_step_viewed', { door: 'provider', step: step + 2 })
        saveGatewayPos({ door: 'provider', screen: 'wizard', step: step + 1 })
        setStep(step + 1)
        setPicked(null)
      } else {
        track('gateway_provider_wizard_completed', { ...answers })
        saveGatewayPos({ door: 'provider', screen: 'apply' })
        setPhase('pexiting')
        setPicked(null)
        arm(() => setPhase('preveal'), 450)
      }
    }, 250)
  }

  function back() {
    if (step > 0) {
      const prev = step - 1
      saveGatewayPos({
        door: phase === 'partner' ? 'provider' : 'msme',
        screen: 'wizard',
        step: prev,
      })
      setStep(prev)
      setPicked(null)
    } else {
      clearGatewayPos()
      setPhase('intro')
      setPicked(null)
    }
  }

  function startOver() {
    clearGatewayPos()
    if (timer.current) clearTimeout(timer.current)
    setPhase('intro')
    setStep(0)
    setPicked(null)
    setFlood(null)
    setBuyer({})
    setProvider({})
    setRestored(false)
  }

  // ── Derived render state (spec names) ─────────────────────────────────────
  const exiting = phase === 'exiting' || phase === 'pexiting'
  const showCard = phase !== 'reveal' && phase !== 'preveal'
  const isIntro = phase === 'intro'
  const isWizard = phase === 'wizard' || phase === 'exiting'
  const isPartner = phase === 'partner' || phase === 'pexiting'
  const warm = phase === 'wizard' || phase === 'partner' || exiting

  return (
    <div
      className="gw-stage fixed inset-0 overflow-hidden bg-[#0E2A21]"
      onMouseMove={onStageMouseMove}
      onMouseLeave={onStageMouseLeave}
    >
      {/* ambient glows + grain (decoration only) */}
      <div aria-hidden className="gw-glow-a pointer-events-none absolute -top-[25%] -left-[15%] h-[60vw] w-[60vw] rounded-chip" />
      <div aria-hidden className="gw-glow-b pointer-events-none absolute -bottom-[30%] -right-[12%] h-[55vw] w-[55vw] rounded-chip" />
      <div aria-hidden className="gw-glow-c pointer-events-none absolute right-[22%] top-[30%] h-[34vw] w-[34vw] rounded-chip" />
      <div aria-hidden className="gw-warm-wash pointer-events-none absolute inset-0" style={{ opacity: warm ? 1 : 0 }} />
      <div aria-hidden className="gw-grain pointer-events-none absolute inset-0" />

      {/* Scene 4 — revealed beneath the card (mounted during the exit so the
          card visibly lifts off it) */}
      {(phase === 'exiting' || phase === 'reveal') && (
        <RevealResults answers={buyer} onStartOver={startOver} onSelectLocale={selectLocale} track={track} />
      )}
      {(phase === 'pexiting' || phase === 'preveal') && (
        <RevealPartner answers={provider} onStartOver={startOver} onSelectLocale={selectLocale} track={track} />
      )}

      {showCard && (
        <>
          {/* logo */}
          <div
            className={`${restored ? '' : 'gw-rise'} pointer-events-none absolute left-0 right-0 top-5 flex justify-center transition-opacity duration-[350ms] ease-in sm:top-[34px]`}
            style={{ animationDelay: '150ms', opacity: exiting ? 0 : 1 }}
          >
            <span className="font-display text-xl font-extrabold tracking-[-0.01em] text-white sm:text-2xl">
              AMClub
            </span>
          </div>

          {/* language chips (dark) */}
          <div
            className={`${restored ? '' : 'gw-fade'} absolute right-3.5 top-3.5 transition-opacity duration-[350ms] ease-in sm:right-8 sm:top-[30px]`}
            style={{ animationDelay: '900ms', opacity: exiting ? 0 : 1, pointerEvents: exiting ? 'none' : 'auto' }}
          >
            <LanguageChips variant="dark" onSelect={selectLocale} />
          </div>

          {/* card stage — bottom sheet on mobile, centered on desktop */}
          <div
            className="absolute inset-0 flex items-end justify-center p-2.5 transition-[transform,opacity] sm:items-center sm:p-6"
            style={{
              transform: exiting ? 'scale(1.08)' : 'scale(1)',
              opacity: exiting ? 0 : 1,
              transitionDuration: '450ms, 400ms',
              transitionTimingFunction: 'ease-in, ease-in',
              pointerEvents: exiting ? 'none' : 'auto',
            }}
          >
            <div className={`${restored ? '' : 'gw-card-enter'} w-full sm:max-w-[520px]`}>
              <div
                ref={cardRef}
                className="relative overflow-hidden rounded-3xl bg-white p-5 pt-[26px] shadow-[0_24px_70px_-18px_rgba(0,0,0,0.5)] will-change-transform sm:rounded-[26px] sm:px-9 sm:pb-8 sm:pt-10 sm:shadow-[0_40px_90px_-20px_rgba(0,0,0,0.45)]"
              >
                {isIntro && <IntroDoors onPick={pickDoor} />}
                {isWizard && (
                  <WizardBuyer
                    step={step}
                    picked={picked}
                    onAnswer={answerBuyer}
                    onBack={back}
                    onSkip={skipWizard}
                  />
                )}
                {isPartner && (
                  <WizardProvider
                    step={step}
                    picked={picked}
                    category={provider.cat ?? null}
                    onAnswer={answerProvider}
                    onBack={back}
                  />
                )}

                {/* selection color-flood: 40px circle at the click point scales
                    ×40 over 400ms, then fades out over 300ms */}
                {flood && (
                  <div
                    aria-hidden
                    className="pointer-events-none absolute -ml-5 -mt-5 h-10 w-10 rounded-chip"
                    style={{
                      left: flood.x,
                      top: flood.y,
                      background: flood.color,
                      transform: flood.on ? 'scale(40)' : 'scale(0.1)',
                      opacity: flood.on ? 1 : 0,
                      transition: flood.on
                        ? 'transform 400ms ease-in-out, opacity 120ms ease-out'
                        : 'opacity 300ms ease-out',
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
