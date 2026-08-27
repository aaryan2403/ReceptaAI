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
  const [authenticated, setAuthenticated] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const checkAdmin = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      if (!session) {
        setAuthenticated(false)
        setIsAdmin(false)
        setLoading(false)
        return
      }

      setAuthenticated(true)

      const admin =
        session.user.email?.toLowerCase() ===
        ADMIN_EMAIL.toLowerCase()

      setIsAdmin(admin)
      setLoading(false)
    }

    checkAdmin()
  }, [])

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

  // /admin itself must stay accessible so Admin.tsx
  // can display the separate admin login form.
  if (!authenticated) {
    if (location.pathname === '/admin') {
      return <>{children}</>
    }

    return <Navigate to="/admin" replace />
  }

  // A logged-in customer cannot enter the admin area.
  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}
