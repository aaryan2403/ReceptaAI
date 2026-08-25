import { type ReactNode, useEffect, useState } from 'react'
import { Navigate } from 'react-router'
import { supabase } from '../lib/supabase'

type ProRouteProps = {
  children: ReactNode
}

export default function ProRoute({
  children,
}: ProRouteProps) {
  const [loading, setLoading] =
    useState(true)

  const [allowed, setAllowed] =
    useState(false)

  useEffect(() => {
    const checkPlan = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setAllowed(false)
        setLoading(false)
        return
      }

      const { data, error } =
        await supabase
          .from('subscriptions')
          .select('plan_name, status')
          .eq('client_id', user.id)
          .maybeSingle()

      if (
        !error &&
        data?.status === 'active' &&
        data?.plan_name ===
          'Recepta Pro'
      ) {
        setAllowed(true)
      }

      setLoading(false)
    }

    checkPlan()
  }, [])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">
          Checking your Recepta plan...
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
