import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

export default function ProtectedRoute({
  children,
}: {
  children: ReactNode
}) {
  const [loading, setLoading] = useState(true)
  const [authenticated, setAuthenticated] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const checkSession = async () => {
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

    checkSession()
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
        Loading...
      </div>
    )
  }

  if (!authenticated) {
    return <Navigate to="/login" replace />
  }

  if (isAdmin) {
    return <Navigate to="/admin" replace />
  }

  return <>{children}</>
}
