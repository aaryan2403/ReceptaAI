import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import EmployeeCalendar from './EmployeeCalendar'
import EmployeeHours from './EmployeeHours'

export default function Employees() {
  const [loading, setLoading] = useState(true)
  const [isPro, setIsPro] = useState(false)

  useEffect(() => {
    const loadPlan = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        setLoading(false)
        return
      }

      const { data } = await supabase
        .from('subscriptions')
        .select('plan_name')
        .eq('client_id', user.id)
        .maybeSingle()

      setIsPro(data?.plan_name === 'Recepta Pro')
      setLoading(false)
    }

    void loadPlan()
  }, [])

  if (loading) {
    return (
      <main className="dashboardPage">
        <section className="dashboardMain">Loading employees...</section>
      </main>
    )
  }

  return isPro ? <EmployeeCalendar /> : <EmployeeHours />
}
