import { useCallback, useEffect, useState } from 'react'
import BillingAccessNotice from '../components/BillingAccessNotice'
import ProBookingsNavItem from '../components/ProBookingsNavItem'
import { bookingRequest, type Booking, type BookingSettings, type BookingWorkspace, type CalendarChoice } from '../lib/bookings'
import { bookingFormTime, localBookingTime } from '../lib/bookingTime'
import './Bookings.css'

const noteText=(value:string|null)=>{
  try {const parsed=JSON.parse(value??'');if(Array.isArray(parsed.details)) return parsed.details.map((d:{label:string;value:string})=>`${d.label}: ${d.value}`).join('\n')} catch {/* Plain text notes. */}
  return value??''
}
const bookingKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('')
const newForm=()=>({id:'',version:0,booking_key:bookingKey(),customer_name:'',customer_phone:'',customer_email:'',service:'',start:'',duration_minutes:30,employee_id:'',notes:''})
export default function Bookings() {
  const [data,setData]=useState<BookingWorkspace|null>(null)
  const [settings,setSettings]=useState<BookingSettings|null>(null)
  const [error,setError]=useState(()=>new URLSearchParams(window.location.search).get('google')==='failed'?'Google connection was cancelled or could not be completed. Please try connecting again.':'')
  const [message,setMessage]=useState(()=>new URLSearchParams(window.location.search).get('google')==='connected'?'Google authorization completed. Select your calendars below.':'')
  const [busy,setBusy]=useState(false)
  const [loading,setLoading]=useState(true)
  const [form,setForm]=useState(newForm)
  const [showForm,setShowForm]=useState(false)
  const [cancelId,setCancelId]=useState<string|null>(null)
  const [choices,setChoices]=useState<CalendarChoice[]|null>(null)
  const [selected,setSelected]=useState<string[]>([])
  const [writer,setWriter]=useState('')
  const load=useCallback(async()=>{
    const result=await bookingRequest<BookingWorkspace>()
    setData(result)
    setSettings(current=>current??result.settings)
    return result
  },[])
  useEffect(()=>{
    let mounted=true
    void load().catch(e=>{if(mounted)setError(e.message)}).finally(()=>{if(mounted)setLoading(false)})
    return()=>{mounted=false}
  },[load])
  useEffect(()=>{
    if(!data?.paid||!data.google.connected||!data.google.selectedCalendars.length) return
    let stopped=false,running=false
    const refresh=async()=>{
      if(running) return
      running=true
      try {await bookingRequest('google-calendar','POST',{action:'refresh'});if(!stopped)await load()}
      catch {if(!stopped)await load().catch(()=>{})}
      finally {running=false}
    }
    void refresh()
    const timer=window.setInterval(refresh,60000)
    return()=>{stopped=true;window.clearInterval(timer)}
  },[data?.paid,data?.google.connected,data?.google.selectedCalendars.length,load])
  const act=async(action:()=>Promise<void>)=>{
    if(busy)return
    setBusy(true);setError('');setMessage('')
    try{await action()}catch(e){setError(e instanceof Error?e.message:'Could not update bookings.')}finally{setBusy(false)}
  }
  const edit=(booking?:Booking)=>{
    setCancelId(null)
    setForm(booking?{id:booking.id,version:booking.booking_version,booking_key:booking.booking_key??bookingKey(),customer_name:booking.customer_name??'',customer_phone:booking.customer_phone??'',customer_email:booking.customer_email??'',service:booking.service??'',start:booking.appointment_time?bookingFormTime(booking.appointment_time,data!.timeZone):'',duration_minutes:booking.duration_minutes??data!.settings.duration_minutes,employee_id:booking.employee_id??'',notes:noteText(booking.notes)}:{...newForm(),duration_minutes:data!.settings.duration_minutes})
    setShowForm(true);setError('');setMessage('')
  }
  const stamp=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:data?.timeZone??'America/Toronto',dateStyle:'medium',timeStyle:'short'}).format(new Date(value))
  const manageCalendars=()=>act(async()=>{
    const result=await bookingRequest<{calendars:CalendarChoice[]}>('google-calendar')
    setChoices(result.calendars);setSelected(data!.google.selectedCalendars.map(c=>c.id));setWriter(data!.google.writeCalendarId??'')
  })
  const upcoming=data?.appointments.filter(a=>a.status==='booked'&&a.appointment_time&&Date.parse(a.appointment_end_time??a.appointment_time)>Date.now()).sort((a,b)=>a.appointment_time!.localeCompare(b.appointment_time!))??[]
  const pending=data?.appointments.filter(a=>a.status==='pending')??[]
  const cancelled=data?.appointments.filter(a=>a.status==='cancelled').slice(0,10)??[]
  return <main className="dashboardPage bookingWorkspace">
    <aside className="dashboardSidebar">
      <a href="/" className="dashboardBrand"><img src="/components/logoR.png" alt="Recepta"/></a>
      <nav className="dashboardNav">
        <a href="/dashboard" className="dashboardNavItem">Overview</a><a href="/dashboard/calls" className="dashboardNavItem">Calls</a>
        <a href="/dashboard/agent" className="dashboardNavItem">Agent</a><ProBookingsNavItem active/>
        <a href="/dashboard/requests" className="dashboardNavItem">Customer Requests</a><a href="/dashboard/billing" className="dashboardNavItem">Billing</a><a href="/dashboard/settings" className="dashboardNavItem">Settings</a>
      </nav>
    </aside>
    <section className="dashboardMain">
      <BillingAccessNotice/>
      <div className="dashboardHeader"><div><p className="dashboardEyebrow">RECEPTA PRO</p><h1>Bookings</h1><p>One availability limit for staff bookings, your AI and connected Google calendars.</p></div>
        {data&&<button className="btn btnPrimary" disabled={busy||!data.paid} onClick={()=>edit()}>Add offline booking</button>}</div>
      {error&&<p className="bookingAlert bookingAlertError" role="alert">{error}</p>}
      {message&&<p className="bookingAlert" role="status">{message}</p>}
      {loading&&<p>Loading bookings…</p>}
      {!loading&&!data&&<p>This workspace requires Recepta Pro. <a href="/dashboard/billing">Review billing</a></p>}
      {data&&settings&&<>
        <section className="bookingPanel"><div className="bookingSectionTitle"><div><p className="dashboardEyebrow">AVAILABILITY</p><h2>Booking rules</h2></div><span className="bookingBadge">{!data.paid?'Billing paused':data.settings.enabled?'AI bookings enabled':'AI requests only'}</span></div>
          <p>Record every phone or walk-in booking here. The AI checks the saved bookings during each call. Appointments can be reserved up to 90 days ahead within your saved business hours.</p>
          <form onSubmit={e=>{e.preventDefault();void act(async()=>{const result=await bookingRequest<BookingWorkspace>('bookings','POST',{action:'settings',...settings});setData(result);setSettings(result.settings);setMessage('Booking rules saved. Your AI uses these limits.')})}}>
            <div className="bookingFields"><label>Maximum simultaneous appointments<input type="number" min="1" max="50" required value={settings.capacity} onChange={e=>setSettings({...settings,capacity:Number(e.target.value)})}/></label>
              <label>Default duration (minutes)<input type="number" min="5" max="480" required value={settings.duration_minutes} onChange={e=>setSettings({...settings,duration_minutes:Number(e.target.value)})}/></label>
              <label>Buffer before and after (minutes)<input type="number" min="0" max="120" required value={settings.buffer_minutes} onChange={e=>setSettings({...settings,buffer_minutes:Number(e.target.value)})}/></label></div>
            <label className="bookingToggle"><input type="checkbox" checked={settings.enabled} onChange={e=>setSettings({...settings,enabled:e.target.checked})}/>Enable confirmed bookings by the AI</label>
            <p className="bookingHint">Times use {data.timeZone}. Manage opening hours on the <a href="/dashboard/agent">Agent page</a>. Reducing capacity does not cancel existing appointments.</p>
            <button className="btn btnPrimary" disabled={busy||!data.paid}>{busy?'Saving…':'Save booking rules'}</button>
          </form>
        </section>
        <section className="bookingPanel"><div className="bookingSectionTitle"><div><p className="dashboardEyebrow">GOOGLE CALENDAR</p><h2>Your connected calendars</h2></div><span className="bookingBadge">{data.google.connected?(data.google.syncedAt&&!data.google.error?'Synced':'Setup / refresh needed'):'Not connected'}</span></div>
          <p>Check appointments from up to five Google calendars and choose one to receive Recepta bookings. Each overlapping busy event counts as one appointment.</p>
          {data.google.error&&<p className="bookingAlert bookingAlertError" role="alert">{data.google.error}</p>}
          {!data.google.configured&&<p className="bookingHint">Google connection setup is required by Recepta. You can still record bookings here; only records saved in Recepta count until Google is connected.</p>}
          {data.google.syncedAt&&<p className="bookingHint">Last checked: {stamp(data.google.syncedAt)}. Availability is checked again before each new booking.</p>}
          <div className="bookingActions">
            <button className="btn btnSecondary" disabled={busy||!data.paid||!data.google.configured} onClick={()=>void act(async()=>{const r=await bookingRequest<{url:string}>('google-calendar','POST',{action:'connect'});window.location.assign(r.url)})}>{data.google.connected?'Reconnect Google':'Connect Google Calendar'}</button>
            {data.google.connected&&<><button className="btn btnSecondary" disabled={busy||!data.paid} onClick={()=>void manageCalendars()}>Choose calendars</button>
              <button className="btn btnSecondary" disabled={busy||!data.paid} onClick={()=>void act(async()=>{await bookingRequest('google-calendar','POST',{action:'refresh'});await load();setMessage('Google Calendar availability refreshed.')})}>Refresh now</button></>}
          </div>
          {choices&&<form className="bookingCalendarChoices" onSubmit={e=>{e.preventDefault();void act(async()=>{await bookingRequest('google-calendar','POST',{action:'select',calendar_ids:selected,write_calendar_id:writer});await load();setChoices(null);setMessage('Calendars selected and availability refreshed.')})}}>
            {choices.map(c=><label className="bookingToggle" key={c.id}><input type="checkbox" checked={selected.includes(c.id)} onChange={e=>setSelected(e.target.checked?[...selected,c.id]:selected.filter(id=>id!==c.id))}/>{c.summary}</label>)}
            <label>Save new bookings to<select required value={writer} onChange={e=>setWriter(e.target.value)}><option value="">Choose a calendar</option>{choices.filter(c=>selected.includes(c.id)&&['owner','writer'].includes(c.accessRole)).map(c=><option key={c.id} value={c.id}>{c.summary}</option>)}</select></label>
            <button className="btn btnPrimary" disabled={busy}>Save calendars</button>
          </form>}
          {data.google.selectedCalendars.map(c=><a className="bookingCalendarLink" key={c.id} href={`https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(c.id)}`} target="_blank" rel="noreferrer">{c.summary} ↗</a>)}
          {data.google.connected&&<details className="bookingDisconnect"><summary>Disconnect Google Calendar</summary><p>Existing Google events remain. Bookings will pause. Record those appointments in Recepta before enabling bookings again.</p><button className="btn btnSecondary" disabled={busy||!data.paid} onClick={()=>void act(async()=>{await bookingRequest('google-calendar','POST',{action:'disconnect'});setChoices(null);const updated=await load();setSettings(updated.settings);setMessage('Google Calendar disconnected. Bookings are paused; record your other appointments before enabling bookings again.')})}>Confirm disconnect</button></details>}
          <p className="bookingHint">For the strongest protection, enter offline bookings here. Unrecorded bookings are invisible to the AI. Simultaneous edits made directly in Google or another booking app can still create conflicts.</p>
        </section>
        {showForm&&<section className="bookingPanel" aria-label="Booking form"><h2>{form.id?'Update booking':'Add offline booking'}</h2>
          <form onSubmit={e=>{e.preventDefault();void act(async()=>{const result=await bookingRequest<BookingWorkspace>('bookings',form.id?'PATCH':'POST',{...form,start:localBookingTime(form.start,data.timeZone)});setData(result);setShowForm(false);setMessage('Booking saved. It now counts toward the availability your AI checks.')})}}>
            <div className="bookingFields"><label>Customer name<input required maxLength={160} value={form.customer_name} onChange={e=>setForm({...form,customer_name:e.target.value})}/></label>
              <label>Phone<input type="tel" value={form.customer_phone} onChange={e=>setForm({...form,customer_phone:e.target.value})}/></label><label>Email (optional)<input type="email" value={form.customer_email} onChange={e=>setForm({...form,customer_email:e.target.value})}/></label>
              <label>Service<input required maxLength={300} value={form.service} onChange={e=>setForm({...form,service:e.target.value})}/></label><label>Start ({data.timeZone})<input type="datetime-local" required value={form.start} onChange={e=>setForm({...form,start:e.target.value})}/></label>
              <label>Duration (minutes)<input type="number" required min={5} max={480} value={form.duration_minutes} onChange={e=>setForm({...form,duration_minutes:Number(e.target.value)})}/></label>
              {data.employees.length>0&&<label>Staff member<select value={form.employee_id} onChange={e=>setForm({...form,employee_id:e.target.value})}><option value="">No specific staff member</option>{data.employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>}</div>
            <label>Appointment notes<textarea maxLength={3000} rows={3} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/></label>
            <div className="bookingActions"><button className="btn btnPrimary" disabled={busy}>{busy?'Saving…':'Save booking'}</button><button type="button" className="btn btnSecondary" disabled={busy} onClick={()=>setShowForm(false)}>Close</button></div>
          </form></section>}
        <section className="bookingPanel"><div className="bookingSectionTitle"><h2>Upcoming appointments</h2><span className="bookingBadge">{upcoming.length}</span></div>{upcoming.length===250&&<p className="bookingHint">Showing the next 250 appointments. Later reservations still count toward capacity.</p>}
          {!upcoming.length&&<p>No upcoming reservations. Record your offline bookings here before enabling AI bookings above.</p>}
          {upcoming.map(a=><article className="bookingRow" key={a.id}><div><h3>{a.customer_name} · {a.service}</h3><p>{stamp(a.appointment_time!)} · {a.duration_minutes} minutes</p><p className="bookingHint">{a.source==='retell'?'AI booking':'Staff booking'}{a.employee_id?` · ${data.employees.find(e=>e.id===a.employee_id)?.name??'Assigned staff'}`:''}</p>
            {data.calendarJobs.some(j=>j.appointment_id===a.id)&&<p className="bookingHint">Google update pending{data.calendarJobs.find(j=>j.appointment_id===a.id)?.last_error?' — retrying automatically':''}.</p>}</div>
            <div className="bookingActions"><button className="btn btnSecondary" disabled={busy||!data.paid} onClick={()=>edit(a)}>Edit / reschedule</button>
              {cancelId===a.id?<><span>Cancel this booking?</span><button className="btn btnSecondary" disabled={busy} onClick={()=>void act(async()=>{const result=await bookingRequest<BookingWorkspace>('bookings','DELETE',{id:a.id,version:a.booking_version});setData(result);setCancelId(null);setMessage('Booking cancelled. Its capacity is available again.')})}>Confirm cancellation</button><button className="btn btnSecondary" onClick={()=>setCancelId(null)}>Keep booking</button></>:<button className="btn btnSecondary" disabled={busy} onClick={()=>setCancelId(a.id)}>Cancel</button>}</div></article>)}
        </section>
        {pending.length>0&&<section className="bookingPanel"><h2>Requests awaiting a reservation</h2><p>These requests do not hold capacity until you confirm an available time.</p>{pending.map(a=><article className="bookingRow" key={a.id}><div><h3>{a.customer_name} · {a.service}</h3><p>{[a.requested_date,a.requested_time].filter(Boolean).join(' · ')||'Time not specified'}</p></div><button className="btn btnSecondary" disabled={busy||!data.paid} onClick={()=>edit(a)}>Choose time &amp; confirm</button></article>)}</section>}
        {data.external.some(e=>!e.local_appointment_id)&&<section className="bookingPanel"><h2>Other Google Calendar appointments</h2><p>These busy events also count toward the shared limit.</p>{data.external.filter(e=>!e.local_appointment_id).map(e=><article className="bookingRow" key={`${e.calendar_id}:${e.event_id}`}><div><h3>{e.title}</h3><p>{stamp(e.starts_at)} – {stamp(e.ends_at)}</p></div></article>)}</section>}
        {cancelled.length>0&&<details className="bookingPanel"><summary>Recently cancelled ({cancelled.length})</summary>{cancelled.map(a=><p key={a.id}>{a.customer_name} · {a.service} · Cancelled</p>)}</details>}
      </>}
    </section>
  </main>
}
