# PRD — WhatsApp as a first-class channel (§8.1 bundle)

**Authorised:** founder, 2026-09-26 ("go ahead build and fix everything"), on `docs/audit/2026-09-26-whatsapp-readiness-audit.md`
and the WhatsApp strategy report (25 Sep 2026). **Decision record:** ADR-030 (consent, suppression, one send path,
the notification outbox). Money-adjacent items carry their own ADR (ADR-031 goods receipt and dispatch on WhatsApp);
auth items carry ADR-032 and ship dark.

## Problem

MSMEs and providers read WhatsApp, not email. The rails exist but cannot go live: consent and opt-out break Meta's
policy and DPDP, Telugu users would receive no templates, providers' WhatsApp agents use the wrong persona, sends from
the web are unlogged, SMS never sends, and several order, refund, dispute and verification events notify nobody.

## Goals

1. Order, request, payment and deadline updates reach every user on the channel they chose, WhatsApp first, with SMS
   and email as fallbacks, and never after they said STOP.
2. The assistant works on WhatsApp for buyers and providers within its scope (Meta's AI terms), in en / hi / te / ta.
3. Ops can see delivery, templates, quality and spend; people can ask for their data and have it erased.

Non-goals (NOT-NOW, §8.3): provider chat before an order, price negotiation in chat, WhatsApp groups or communities,
paying a provider directly, video, international numbers.

## Scope and RICE

Reach = active accounts touched per quarter (pilot ~550); Impact 0.25–3; Confidence %; Effort in person-weeks.

| Item | Reach | Impact | Conf. | Effort | RICE | Wave |
|---|---|---|---|---|---|---|
| W0 safety: consent ledger, STOP for everything, keywords, template language, persona, Graph version, send service + ledger, cost capture, cohort mode | 550 | 3 | 90 % | 2 | 743 | 1 |
| W1 transactional: event → channel registry, outbox + retry + SMS fallback, reminders, missing notices (refund, dispute, verification, new quote), preferences + quiet hours, HELP menu, safety page | 550 | 2 | 80 % | 3 | 293 | 1 |
| Privacy ops: retention, DPDP requests, transcript audit, corpus exclusion, admin WhatsApp console | 550 | 1 | 80 % | 1.5 | 293 | 1 |
| W2 assistant: one router, off-topic steer-back, voice pipeline, photo intake, procurement enable from WhatsApp, Munshi quotes from chat, Tamil, conversation mirror | 300 | 2 | 70 % | 3 | 140 | 2 |
| W3a commerce: pool messages + pay link, goods receipt / dispatch on WhatsApp (ADR-031), click-to-WhatsApp attribution | 150 | 1 | 70 % | 2 | 53 | 2 |
| W3b Flows (address, goods request), catalog cards, campaigns with marketing consent (dark) | 200 | 1 | 50 % | 3 | 33 | 3 |
| W4 dark: voice replies, calling, account from WhatsApp, WhatsApp OTP, phone change, second number, team members (ADR-032) | 100 | 1 | 50 % | 3 | 17 | 3 |

## Founder decisions (defaults the build uses)

| # | Decision | Default |
|---|---|---|
| D-WA1 | After STOP | Nothing on WhatsApp; SMS, email and in-app carry order and payment updates. |
| D-WA2 | Who gets the assistant on WhatsApp | `cohort_mode = list` (today's allowlist) until the founder sets `all`; the non-AI HELP menu serves everyone. |
| D-WA3 | Marketing on WhatsApp | Built dark (`wa_marketing_enabled = false`); separate consent; cap 2 per user per week. |
| D-WA4 | Meta account | Created in INR, business verification, dedicated number; one official number shown everywhere. |
| D-WA5 | Retention | Text 180 days, media 90 days, never-registered numbers 30 days; legal hold for orders, disputes and tickets (settings). |
| D-WA6 | WhatsApp OTP fallback | Built dark behind ADR-032. |
| D-WA7 | Invoice "TEST MODE" line | Stays until the CA signs off the GST structure. |
| D-WA8 | Model data terms | `AGENT_OPENROUTER_ZDR=true` on Vercel and Fly; DPAs recorded in `docs/agents/SECURITY.md`. |

## Rollout

Everything ships behind switches (`WHATSAPP_DRIVER`, `agent_settings`, `NOTIFY_OUTBOX`), default off, with
migrations 0086 / 0087 applied after each build is live. Go-live checklist: Meta number + INR account, templates
approved (generated list in `docs/PRE_LAUNCH_CHECKLIST.md` 1.3), MSG91 DLT templates, env set, a pilot cohort.

## Metrics

Opt-in rate at signup; WhatsApp delivered / read rate; fallback rate; STOP rate per template; notification-to-action
time (quote viewed after `rfq_new_quote`); support tickets from WhatsApp; cost per active account per month.
