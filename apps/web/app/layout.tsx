import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: {
    template: '%s | AMClub',
    default: 'AMClub — Every service your business needs',
  },
  description:
    "AMClub is the trusted B2B services marketplace for India's MSMEs — legal, CA, HR, finance, marketing and more. Verified providers. Transparent pricing. Safe payments.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children
}
