'use client'

import dynamic from 'next/dynamic'

/**
 * Client-side lazy boundary for the gateway wizard. `next/dynamic` must sit
 * in a client component for webpack to emit a separate async chunk: called
 * from a server component it only defers the SERVER import, and the wizard
 * stayed in the root page's client chunk — which Next merges into every
 * route under [locale], so /mart and /services downloaded it. Still
 * server-rendered (ssr: true); the chunk is preloaded on `/` from the
 * loadable manifest.
 */
export const GatewayLazy = dynamic(() => import('./Gateway').then((m) => m.Gateway), { ssr: true })
