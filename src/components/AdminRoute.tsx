import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

export default function AdminRoute({
  children,
}: {
  children: ReactNode
}) {
  const location = useLocation()

  const [loading, setLoading] = useState(true)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const checkAdmin = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const admin =
        session?.user.email?.trim().toLowerCase() ===
        ADMIN_EMAIL.toLowerCase()

      setIsAdmin(admin)
      setLoading(false)
    }

    checkAdmin()
  }, [])

  // The main /admin page must ALWAYS be reachable.
  // Admin.tsx handles its own separate login.
  if (location.pathname === '/admin') {
    return <>{children}</>
  }

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#050505',
          color: '#fff',
        }}
      >
        Checking admin access...
      </div>
    )
  }

  // Protect pages such as /admin/client/:id
  if (!isAdmin) {
    return <Navigate to="/admin" replace />
  }

  return <>{children}</>
}
