import { redirect } from 'next/navigation'

// Admin landing → the verification queue (the primary ops surface in V1).
export default function AdminRootPage() {
  redirect('/admin/verifications')
}
