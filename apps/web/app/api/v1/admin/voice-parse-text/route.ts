import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { getParser } from '@/lib/voice/parser'
import { parserVendorTag } from '@/lib/voice/parser'
import { VendorHttpError, classifyVendorFailure } from '@/lib/voice/types'
import { estimateParseCostPaise, logAiInvocation } from '@/lib/voice/invocations'

/**
 * Phase 8 §6 — ADMIN diagnostic: run the voice-RFQ PARSER on plain text with
 * the server's live config (key/model/prompt). Exists so the golden-set eval
 * (scripts/eval-ai-golden.ts, tests/ai-golden/) can exercise the real vendor
 * from environments that don't hold the OpenRouter key, and so ops can probe
 * prompt changes. Paid call → admin-only + rate-limited; every call writes an
 * ai_invocations row under feature 'voice_eval'.
 */

const bodySchema = z.object({
  text: z.string().trim().min(5).max(2000),
  lang: z.string().max(16).default('en'),
})

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth.error) return auth.error

  const rl = await enforce(limiters.adminMutation, `vpt:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const t0 = Date.now()
  try {
    const result = await getParser().parse(parsed.data.text, parsed.data.lang)
    await logAiInvocation(admin, {
      userId: auth.userId,
      feature: 'voice_eval',
      step: 'parse',
      vendor: result.vendor,
      status: result.stub ? 'stub' : 'ok',
      latencyMs: Date.now() - t0,
      costEstPaise: estimateParseCostPaise(result.usage, result.stub),
      outputChars: result.parse.description_english.length,
      requestId: result.requestId ?? null,
      meta: result.usage ? { usage: result.usage } : undefined,
    })
    return NextResponse.json({ parse: result.parse, vendor: result.vendor, stub: result.stub })
  } catch (e) {
    await logAiInvocation(admin, {
      userId: auth.userId,
      feature: 'voice_eval',
      step: 'parse',
      vendor: parserVendorTag(),
      status: 'error',
      latencyMs: Date.now() - t0,
      costEstPaise: null,
      error: e instanceof Error ? e.message.slice(0, 500) : String(e),
      meta: e instanceof VendorHttpError ? { vendor_status: e.status, vendor_body: e.body.slice(0, 4000) } : undefined,
    })
    return NextResponse.json(
      { error: 'parse_failed', cause: classifyVendorFailure(e) },
      { status: 502 },
    )
  }
}
