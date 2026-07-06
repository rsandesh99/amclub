/**
 * Minimal PostHog wrapper (Phase 8b). Lazily initialises posthog-react-native
 * when EXPO_PUBLIC_POSTHOG_KEY is set; otherwise logs locally so funnels stay
 * debuggable in dev. Event names live in docs/DESIGN.md Appendix A.
 */
import PostHog from 'posthog-react-native'

let client: PostHog | null | undefined

export function track(event: string, props?: Record<string, unknown>) {
  if (client === undefined) {
    const key = process.env.EXPO_PUBLIC_POSTHOG_KEY
    client = key
      ? new PostHog(key, {
          host: process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://eu.posthog.com',
        })
      : null
  }
  const enriched = { device: 'mobile', ...props }
  if (client) client.capture(event, enriched)
  else console.log(`[analytics] ${event}`, enriched)
}
