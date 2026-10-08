import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function AdminRequestsNavItem({
  active = false,
  count: suppliedCount,
}: {
  active?: boolean
  count?: number
}) {
  const [loadedCount, setLoadedCount] = useState(0)

  useEffect(() => {
    if (typeof suppliedCount === 'number') return

    let cancelled = false

    const loadCount = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session?.access_token) return

      const response = await fetch(
        '/.netlify/functions/admin-customer-requests',
        {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        }
      )
      const result = await response.json().catch(() => ({}))

      if (!cancelled && response.ok) {
        setLoadedCount(
          typeof result?.newCount === 'number' ? result.newCount : 0
        )
      }
    }

    void loadCount()

    return () => {
      cancelled = true
    }
  }, [suppliedCount])

  const count = suppliedCount ?? loadedCount

  return (
    <a
      href="/admin/requests"
      className={`adminNavItem${
        active ? ' adminNavItem--active' : ''
      }`}
    >
      <span>Customer Requests</span>
      {count > 0 && (
        <span
          className="adminRequestBadge"
          aria-label={`${count} new customer ${
            count === 1 ? 'request' : 'requests'
          }`}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </a>
  )
}
