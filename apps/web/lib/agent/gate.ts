import 'server-only'
import { NextResponse } from 'next/server'
import { notFound } from 'next/navigation'
import { AGENT_ENABLED } from '@/lib/flags'

/**
 * Agent flag gate (ADR-009 §7; mirrors lib/mart/gate.ts). Every /api/v1/agent/*
 * route calls agentApiGate() FIRST and every agent page calls agentPageGate()
 * FIRST — while AGENT_ENABLED=false the surfaces do not exist (hard 404), so
 * nothing downstream can run and the whole programme ships dark.
 */
export function agentApiGate(): NextResponse | null {
  if (AGENT_ENABLED) return null
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export function agentPageGate(): void {
  if (!AGENT_ENABLED) notFound()
}
