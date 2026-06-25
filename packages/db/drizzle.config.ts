import { defineConfig } from 'drizzle-kit'
import * as dotenv from 'dotenv'
import * as path from 'path'

// Load .env from repo root when running db commands directly
// Try web app env first (DATABASE_URL lives there), then repo root
dotenv.config({ path: path.resolve(__dirname, '../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Add it to .env at the repo root.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  // Use Supabase's public schema
  schemaFilter: ['public'],
  verbose: true,
  strict: true,
})
