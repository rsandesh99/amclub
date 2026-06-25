import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema/index'

/**
 * Server-side Drizzle client backed by the Supabase Postgres connection string.
 * Import this only in server-side code (API routes, server components, jobs).
 * Never import in client-side bundles.
 */
function createDb() {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is not set')

  const client = postgres(url, {
    prepare: false, // Required for Supabase's pgBouncer in transaction mode
  })

  return drizzle(client, { schema })
}

export const db = createDb()
export type Db = typeof db
