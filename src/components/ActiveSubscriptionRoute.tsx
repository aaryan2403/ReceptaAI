import { type ReactNode, useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { supabase } from '../lib/supabase'

type ActiveSubscriptionRouteProps = {
  children: ReactNode
}

export default function ActiveSubscriptionRoute({
  children,
}: ActiveSubscriptionRouteProps) {
  const [loading, setLoading] =
    useState(true)

  const [allowed, setAllowed] =
    useState(false)

  useEffect(() => {
    const checkSubscription =
      async () => {
        const {
          data: { user },
        } =
          await supabase.auth.getUser()

        if (!user) {
          setAllowed(false)
          setLoading(false)
          return
        }

        const { data, error } =
          await supabase
            .from('subscriptions')
            .select('status')
            .eq(
              'client_id',
              user.id
            )
            .maybeSingle()

        if (
          !error &&
          data?.status === 'active'
        ) {
          setAllowed(true)
        }

        setLoading(false)
      }

    checkSubscription()
  }, [])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Checking subscription...
        </section>
      </main>
    )
  }

  if (!allowed) {
    return (
      <Navigate
        to="/dashboard"
        replace
      />
    )
  }

  return <>{children}</>
}
