import { ImageResponse } from 'next/og'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool, poolProgressFor } from '@/lib/mart/pools'
import { MART_ENABLED } from '@/lib/flags'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'

export const runtime = 'nodejs'
export const alt = 'AMC Mart group buy'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

// Static Noto Sans 400/700 subsets (Latin + ₹) for the OG renderer: satori
// draws only from fonts it is given, and its bundled default lacks the rupee
// sign. ~30 KB each, read once per instance.
let fontsPromise: Promise<{ name: string; data: Buffer; weight: 400 | 700; style: 'normal' }[]> | null = null
function fonts() {
  fontsPromise ??= Promise.all(
    ([400, 700] as const).map(async (weight) => ({
      name: 'Noto Sans',
      data: await readFile(join(process.cwd(), 'app', 'fonts', `noto-sans-og-${weight}.ttf`)),
      weight,
      style: 'normal' as const,
    })),
  )
  return fontsPromise
}

/** Product photo → 300px PNG data URI (satori renders PNG/JPEG only; uploads are WebP/SVG). */
async function photoDataUri(url: string | null): Promise<string | null> {
  if (!url) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.image) }) // audit M37: a slow host renders the card without the photo
    if (!res.ok) return null
    const png = await sharp(Buffer.from(await res.arrayBuffer())).resize(300, 300, { fit: 'cover' }).png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * The WhatsApp pool card (FRONTEND.md §7): emerald-deep ground, faint jaali
 * lattice, product photo, gold price numeral, molten progress with the
 * minimum tick, close time. Every number is the pool row's.
 */
export default async function PoolOgImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const pool = MART_ENABLED && /^[0-9a-f-]{36}$/i.test(id) ? await getPool(await createAdminClient(), id) : null
  const [fontList, photo] = await Promise.all([fonts(), photoDataUri(pool?.imageUrl ?? null)])
  const progress = pool ? poolProgressFor(pool) : null
  const closes = pool ? new Date(pool.closes_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''
  const saving = pool?.list_price_paise && pool.list_price_paise > pool.unit_price_paise ? Math.round(((pool.list_price_paise - pool.unit_price_paise) / pool.list_price_paise) * 100) : 0
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: '#0A2E22', color: '#FCFAF3', padding: 56, fontFamily: 'Noto Sans', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(circle at 25% 25%, rgba(201,162,39,0.10) 0 2px, transparent 3px)', backgroundSize: '48px 48px', display: 'flex' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 26, letterSpacing: 2, color: '#EDD27A' }}>
          <div style={{ width: 14, height: 14, borderRadius: 999, background: '#3FB08C', display: 'flex' }} />
          AMC MART · GROUP BUY
        </div>
        {pool ? (
          <div style={{ display: 'flex', gap: 40, marginTop: 28, flex: 1 }}>
            <div style={{ width: 300, height: 300, borderRadius: 16, background: '#143F33', display: 'flex', overflow: 'hidden' }}>
              {photo ? <img src={photo} alt="" width={300} height={300} style={{ objectFit: 'cover', width: 300, height: 300 }} /> : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ fontSize: 48, fontWeight: 700, lineHeight: 1.1, display: 'flex' }}>{pool.title}</div>
              {pool.seller && <div style={{ fontSize: 26, color: 'rgba(252,250,243,0.8)', marginTop: 8, display: 'flex' }}>{pool.seller.displayName}{pool.seller.city ? ` · ${pool.seller.city}` : ''}</div>}
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 24 }}>
                <div style={{ fontSize: 76, fontWeight: 800, color: '#EDD27A', display: 'flex' }}>{inr(pool.unit_price_paise)}</div>
                <div style={{ fontSize: 28, color: 'rgba(252,250,243,0.8)', display: 'flex' }}>per {pool.unit} · excl. GST</div>
                {saving > 0 && <div style={{ fontSize: 28, color: '#3FB08C', fontWeight: 700, display: 'flex' }}>save {saving}%</div>}
              </div>
              <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column' }}>
                <div style={{ position: 'relative', height: 22, borderRadius: 999, background: 'rgba(252,250,243,0.15)', display: 'flex', overflow: 'hidden' }}>
                  <div style={{ width: `${progress!.pct}%`, height: '100%', background: 'linear-gradient(90deg,#8C6D14,#C9A227 40%,#EDD27A 60%,#C9A227)', display: 'flex' }} />
                  <div style={{ position: 'absolute', left: `${progress!.metPct}%`, top: 0, width: 4, height: '100%', background: '#FCFAF3', display: 'flex' }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 28 }}>
                  <div style={{ display: 'flex' }}>{pool.committed_qty}/{pool.target_qty} {pool.unit} · {pool.member_count} members</div>
                  <div style={{ display: 'flex', color: 'rgba(252,250,243,0.8)' }}>{progress!.met ? 'Minimum reached' : `${progress!.remainingToMin} ${pool.unit} to go`}</div>
                </div>
                <div style={{ fontSize: 26, color: '#EDD27A', marginTop: 10, display: 'flex' }}>{pool.status === 'open' ? `Closes ${closes} IST` : 'Closed'}</div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 56, fontWeight: 700, marginTop: 120, display: 'flex' }}>Buy together, pay less.</div>
        )}
      </div>
    ),
    { ...size, fonts: fontList },
  )
}
