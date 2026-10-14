import { useEffect, useState } from 'react'
import { calculateMonthlyPriceCad, EXTRA_PHONE_NUMBER_MONTHLY_CAD, PII_REDACTION_PER_MINUTE_CAD, SAFETY_GUARDRAILS_PER_MINUTE_CAD, STANDARD_BASE_MONTHLY_CAD, PRO_BASE_MONTHLY_CAD } from '../../netlify/lib/pricing'

type Model = { id: string; display_name: string; tier_name: string; customer_price_per_minute_cad: string | number }
const money = (value: number) => `C$${value.toFixed(2)}`

export default function PublicPricing() {
  const [models, setModels] = useState<Model[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [plan, setPlan] = useState<'Recepta Standard' | 'Recepta Pro'>('Recepta Standard')
  const [minutes, setMinutes] = useState('300')
  const [pii, setPii] = useState(false)
  const [guardrails, setGuardrails] = useState(false)
  const [numbers, setNumbers] = useState('0')
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/.netlify/functions/public-pricing', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Pricing is temporarily unavailable. Contact us for a full quote.')
      const result = await response.json()
      if (!result.models?.length) throw new Error('Contact us for available models and a full quote.')
      setModels(result.models); setSelectedModel(result.models[0].id)
    }).catch(error => { if (error.name !== 'AbortError') setError(error.message) })
    return () => controller.abort()
  }, [])
  const model = models.find(model => model.id === selectedModel)
  const allowance = Math.floor(Number(minutes))
  const extraNumbers = Number(numbers)
  const valid = Boolean(model) && Number.isFinite(allowance) && allowance >= 1 && allowance <= 100_000_000 && Number.isInteger(extraNumbers) && extraNumbers >= 0 && extraNumbers <= 20
  const rate = Number(model?.customer_price_per_minute_cad ?? 0)
  const base = plan === 'Recepta Pro' ? PRO_BASE_MONTHLY_CAD : STANDARD_BASE_MONTHLY_CAD
  const total = valid ? calculateMonthlyPriceCad({ planName: plan, monthlyMinutes: allowance, modelPricePerMinuteCad: rate, piiRedactionEnabled: pii, safetyGuardrailsEnabled: guardrails, extraPhoneNumbers: extraNumbers }) : null

  return <div className="publicPriceBreakdown">
    <div><span className="eyebrow">FULL MONTHLY COST</span><h3>Choose a budget. See every charge.</h3><p>The base fee includes setup, ongoing support and one phone number. Purchased call minutes and selected extras are added below.</p></div>
    <div className="publicPriceGrid">
      <div className="publicPriceInputs">
        <label>Plan<select value={plan} onChange={event => setPlan(event.target.value as typeof plan)}><option>Recepta Standard</option><option>Recepta Pro</option></select></label>
        <label>AI model<select value={selectedModel} onChange={event => setSelectedModel(event.target.value)} disabled={!models.length}>{!models.length && <option>Loading available models…</option>}{models.map(model => <option key={model.id} value={model.id}>{model.tier_name} · {model.display_name} · C${Number(model.customer_price_per_minute_cad).toFixed(3)}/min</option>)}</select></label>
        <label>Purchased minutes per month<input type="number" min="1" max="100000000" step="1" value={minutes} onChange={event => setMinutes(event.target.value)} /></label>
        <label>Additional phone numbers<input type="number" min="0" max="20" step="1" value={numbers} onChange={event => setNumbers(event.target.value)} /></label>
        <label className="publicPriceCheck"><input type="checkbox" checked={pii} onChange={event => setPii(event.target.checked)} /><span>PII redaction · C$0.014 per purchased minute</span></label>
        <label className="publicPriceCheck"><input type="checkbox" checked={guardrails} onChange={event => setGuardrails(event.target.checked)} /><span>Safety Guardrails · C$0.007 per purchased minute</span></label>
      </div>
      <div className="publicPriceSummary" aria-live="polite">
        {error ? <p role="alert">{error}</p> : !models.length ? <p>Loading current model rates…</p> : !valid ? <p>Enter at least one minute and between 0 and 20 additional numbers.</p> : <>
          <div><span>Base service fee</span><strong>{money(base)}</strong></div>
          <div><span>{allowance.toLocaleString()} minutes × C${rate.toFixed(3)}</span><strong>{money(allowance * rate)}</strong></div>
          <div><span>PII redaction {pii ? '(selected)' : '(off)'}</span><strong>{money(pii ? allowance * PII_REDACTION_PER_MINUTE_CAD : 0)}</strong></div>
          <div><span>Safety Guardrails {guardrails ? '(selected)' : '(off)'}</span><strong>{money(guardrails ? allowance * SAFETY_GUARDRAILS_PER_MINUTE_CAD : 0)}</strong></div>
          <div><span>{extraNumbers} additional numbers × C$20</span><strong>{money(extraNumbers * EXTRA_PHONE_NUMBER_MONTHLY_CAD)}</strong></div>
          <div className="publicPriceTotal"><span>Monthly total</span><strong>{money(total!)}</strong></div>
          <p>Canadian dollars, before any applicable tax. Final charges are shown before payment. Rates shown here come from the current model catalogue.</p>
        </>}
      </div>
    </div>
    <div className="publicPriceNotes"><p><strong>How minutes work:</strong> you pay for your selected monthly allowance. Eligible unused minutes roll into the next paid period, capped at one monthly allowance. Calls stop at the approved allowance; extra usage is not silently billed.</p><p><strong>What Pro adds:</strong> appointment request intake and full call details. Your team confirms availability; a request does not reserve a calendar slot.</p><p><strong>Setup and changes:</strong> no separate setup charge in standard subscription Checkout. Custom website work or additional integrations require a separate agreed quote. Subscriptions renew monthly until cancelled; manage payments and cancellation from Billing.</p></div>
  </div>
}
