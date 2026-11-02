import { useState } from 'react'
import { saveAdminSchedulePreference } from '../lib/clientCalls'
import { readStoreHours, type OperatingDay, type StoreHours } from '../lib/storeHours'
import './AdminStoreHours.css'

export default function AdminStoreHours({ clientId, businessHours, onSaved }: {
  clientId: string
  businessHours?: string | null
  onSaved: (hours: string) => void
}) {
  const [schedule, setSchedule] = useState(() => readStoreHours(businessHours))
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const updateSchedule = (updates: Partial<StoreHours>) => setSchedule(current => ({ ...current, ...updates }))
  const updateDay = (index: number, updates: Partial<OperatingDay>) => setSchedule(current => ({
    ...current, hours: current.hours.map((day, i) => i === index ? { ...day, ...updates } : day),
  }))
  const save = async () => {
    if (!schedule.mode || saving) return
    setSaving(true); setError(''); setMessage('')
    try {
      const result = await saveAdminSchedulePreference(clientId, schedule.mode, {
        operatingHours: schedule.hours, timeZone: schedule.timeZone, answeringMode: schedule.answeringMode,
      })
      if (!result.businessHours) throw new Error('The saved store hours were not returned. Please refresh and check.')
      onSaved(result.businessHours)
      setMessage(result.retellSynced
        ? 'Store hours saved and synced with the AI agent.'
        : 'Store hours saved. Assign an AI agent and save the client to sync them.')
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save store hours.') }
    finally { setSaving(false) }
  }
  return <section className="adminNotificationPanel adminStoreHours" style={{ gridColumn: '1 / -1' }} aria-label="Admin store hours">
    <div className="adminNotificationHeading">
      <div><strong>Store hours &amp; AI answering</strong><p>Set the hours supplied by this business. Customers can view their saved hours and request changes from Recepta.</p></div>
      <span>ADMIN CONTROLLED</span>
    </div>
    <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: 16 }}>
      <label><span>Store availability</span>
        <select aria-label="Store availability" value={schedule.mode ?? ''} onChange={event => updateSchedule({ mode: event.target.value as '24/7' | 'custom' })}>
          <option value="" disabled>Choose store hours</option><option value="24/7">Open 24/7</option><option value="custom">Custom weekly hours</option>
        </select>
      </label>
      <label><span>Business timezone</span><input value={schedule.timeZone} onChange={event => updateSchedule({ timeZone: event.target.value })} placeholder="America/Toronto" /></label>
      {schedule.mode === 'custom' && <div style={{ display: 'grid', gap: 12 }}>
        {schedule.hours.map((day, index) => <div key={day.day} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 130 }}>
            <input type="checkbox" checked={day.open} style={{ width: 18, minHeight: 18 }} onChange={event => updateDay(index, { open: event.target.checked })} />{day.day}
          </label>
          {day.open ? <>
            <input type="time" aria-label={`${day.day} opening time`} value={day.start} onChange={event => updateDay(index, { start: event.target.value })} />
            <span>to</span>
            <input type="time" aria-label={`${day.day} closing time`} value={day.end} onChange={event => updateDay(index, { end: event.target.value })} />
          </> : <span>Closed</span>}
        </div>)}
      </div>}
      <label><span>When should the AI answer calls?</span>
        <select aria-label="When should the AI answer calls?" value={schedule.answeringMode} onChange={event => updateSchedule({ answeringMode: event.target.value as '24/7' | 'business_hours' })}>
          <option value="24/7">24/7, including outside store hours</option><option value="business_hours">Only during store hours</option>
        </select>
      </label>
      <button type="button" className="btn btnPrimary" disabled={!schedule.mode} onClick={() => void save()}>{saving ? 'Saving & Syncing...' : 'Save Store Hours & Update Agent'}</button>
    </fieldset>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>
}
