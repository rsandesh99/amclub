/**
 * Bare layout for `/` — the Phase 8a gateway paints its own full-viewport
 * stage, so no PublicHeader/Footer here. The GATEWAY_ENABLED=false fallback
 * (LegacyLanding) brings its own header/footer inside the page instead.
 */
export default function GatewayLayout({ children }: { children: React.ReactNode }) {
  return children
}
