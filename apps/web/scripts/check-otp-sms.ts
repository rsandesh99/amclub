/**
 * B4-prep (STATUS_AUDIT) — phone-OTP delivery diagnosis. The repo cannot see
 * whether Supabase's SMS provider (MSG91) is configured; this script sends ONE
 * real OTP and prints Supabase's exact response so the answer takes 30 seconds:
 *
 *   npx tsx scripts/check-otp-sms.ts +919876543210
 *
 * Success → an SMS should arrive on the handset (also proves DLT templates).
 * "unsupported phone provider" / "SMS provider not configured" → configure
 * Auth → Providers → Phone in the Supabase dashboard before pilot (B4).
 * Rate limits apply (5/identifier/15min) — don't hammer it.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const phone = process.argv[2]
if (!phone || !/^\+91[6-9]\d{9}$/.test(phone)) {
  console.error('Usage: npx tsx scripts/check-otp-sms.ts +91XXXXXXXXXX (Indian mobile, E.164)')
  process.exit(1)
}

const anon = createClient(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
  { auth: { persistSession: false } },
)

async function main() {
  console.log(`Sending OTP to ${phone} via Supabase Auth…`)
  // Validated + process.exit'd above; narrowing doesn't cross function scopes.
  const { error } = await anon.auth.signInWithOtp({ phone: phone!, options: { shouldCreateUser: false } })
  if (error) {
    console.error(`\n✗ OTP send FAILED — status ${error.status}:\n  ${error.message}`)
    console.error(
      '\nIf this mentions the phone/SMS provider: configure MSG91 under Supabase → Auth → Providers → Phone. Phone OTP is DEAD in production until then (B4).',
    )
    process.exit(1)
  }
  console.log('\n✓ Supabase accepted the OTP send. Check the handset for the SMS.')
  console.log('  (Accepted ≠ delivered — no SMS within a minute means a provider/DLT issue.)')
}

main()
