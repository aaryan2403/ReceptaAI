import { useEffect, useRef, useState } from 'react'
import type { WebCallSession } from 'retell-client-js-sdk'

type DemoInfo = { label: string; expiresAt: string; attemptsRemaining: number }

export default function Demo() {
  const [token] = useState(() => window.location.hash.slice(1))
  const [info, setInfo] = useState<DemoInfo | null>(null)
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'connecting' | 'live' | 'ended'>('idle')
  const [error, setError] = useState('')
  const [remaining, setRemaining] = useState(180)
  const sessionRef = useRef<WebCallSession | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    if (!token) return () => { alive.current = false }
    void fetch('/.netlify/functions/demo-call', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Recepta-Demo': token },
      body: JSON.stringify({ action: 'inspect' }), signal: controller.signal,
    }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Demo unavailable.')
      if (alive.current) setInfo(result)
    }).catch(error => { if (alive.current && error.name !== 'AbortError') setError(error.message) })
    return () => { alive.current = false; controller.abort(); void sessionRef.current?.end() }
  }, [token])

  useEffect(() => {
    if (status !== 'live') return
    const end = Date.now() + 180000
    const timer = window.setInterval(() => {
      const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      setRemaining(seconds)
      if (seconds === 0) { void sessionRef.current?.end(); window.clearInterval(timer) }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const start = async () => {
    if (!consent || !info || info.attemptsRemaining < 1 || status === 'connecting' || status === 'live') return
    setError(''); setStatus('connecting'); setRemaining(180)
    try {
      const { RetellClient } = await import('retell-client-js-sdk')
      if (!alive.current) return
      const client = new RetellClient({ key: 'server-managed-demo', fetch: async input => {
        // SDK cleanup can request Stop Call. It must never redeem another demo.
        if (new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname !== '/v3/create-web-call') return new Response(null, { status: 404 })
        const response = await fetch('/.netlify/functions/demo-call', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Recepta-Demo': token },
          body: JSON.stringify({ action: 'start', consent: true }),
        })
        if (response.ok && alive.current) setInfo(current => current ? { ...current, attemptsRemaining: Math.max(0, current.attemptsRemaining - 1) } : current)
        return response
      } })
      const call = client.createWebCall({ agent_id: 'server-selected-demo', transcript: false, hooks: {
        onStatus: value => { if (alive.current && (value === 'live' || value === 'ended')) setStatus(value) },
        onEnd: () => { if (alive.current) setStatus('ended') },
        onError: () => { if (alive.current) setError('Could not connect. Allow microphone access and open the link in Chrome, Safari, or Edge. Ask Recepta for a new link if your attempts are used up.') },
      } })
      sessionRef.current = call
      await call.ready
      if (!alive.current) await call.end()
    } catch {
      if (alive.current) { setStatus('ended'); setError('The demo could not start. Check microphone permission and ask Recepta for help or a replacement link.') }
    }
  }

  return <main className="publicPage demoPage">
    <a className="publicBrand" href="/"><img src="/components/logoR.png" alt="Recepta" /></a>
    <section className="demoCard">
      <span className="eyebrow">TRY THE VOICE</span>
      <h1>{info?.label || 'Recepta voice demo'}</h1>
      <p className="publicLead">Hear how an AI receptionist answers questions and handles a pretend enquiry. No signup or phone number needed.</p>
      <div className={`demoOrb ${status === 'live' ? 'demoOrbLive' : ''}`} aria-hidden="true">R</div>
      <p className="demoStatus" role="status">{status === 'live' ? `Talking · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} left` : status === 'connecting' ? 'Connecting… allow your microphone' : status === 'ended' ? 'Demo ended' : 'Up to 3 minutes per conversation'}</p>
      <div className="demoIdeas"><strong>Try asking</strong><ul><li>“What services do you offer?”</li><li>“When are you open?”</li><li>“I’d like to request an appointment.”</li></ul></div>
      {info && <p className="demoHint">{info.attemptsRemaining} attempts left · Link expires {new Date(info.expiresAt).toLocaleDateString()}</p>}
      {info && status !== 'live' && status !== 'connecting' && <label className="demoConsent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} /><span>I agree to the <a href="/terms" target="_blank" rel="noreferrer">terms</a> and <a href="/privacy" target="_blank" rel="noreferrer">privacy notice</a>. My microphone audio is processed by Retell and its AI providers to run this demo. Use made-up details; this demo makes no real appointments.</span></label>}
      {error && <p className="demoError" role="alert">{error}</p>}
      {!token ? <p className="demoHint">Ask Recepta for your demo link, or <a href="https://cal.com/recepta/30min">book a walkthrough</a>.</p> : !info && !error ? <p>Loading your demo…</p> : null}
      {status === 'live' || status === 'connecting' ? <div className="demoActions"><button className="btn btnPrimary btnLg" onClick={() => void sessionRef.current?.end()}>End demo</button>{status === 'live' && <button className="btn btnOutline" onClick={() => void sessionRef.current?.startAudioPlayback()}>Can’t hear? Enable audio</button>}</div> : info && <button className="btn btnPrimary btnLg" disabled={!consent || info.attemptsRemaining < 1} onClick={() => void start()}>{status === 'ended' ? 'Try again' : 'Talk to the demo'}</button>}
      <p className="demoHint">Use headphones for clearer audio. Standard Retell usage costs are paid by Recepta; you are not charged for trying this link.</p>
      <a className="btn btnOutline" href="https://cal.com/recepta/30min">Discuss this for your business</a>
    </section>
    <nav className="publicFooter"><a href="/">Recepta home</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
  </main>
}
