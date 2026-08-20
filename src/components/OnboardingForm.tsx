import { useState } from 'react'
import { supabase } from '../lib/supabase'

type Props = {
  clientId: string
  companyName: string
}

export default function OnboardingForm({
  clientId,
  companyName,
}: Props) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const [form, setForm] = useState({
    business_phone: '',
    business_hours: '',
    services: '',
    pricing_notes: '',
    service_area: '',
    faqs: '',
    transfer_number: '',
    emergency_rules: '',
    appointment_types: '',
    appointment_lengths: '',
    cancellation_rules: '',
    tone_preference: '',
    voice_preference: '',
    forbidden_topics: '',
    notification_preferences: '',
    onboarding_notes: '',
  })

  const updateField = (field: string, value: string) => {
    setForm((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const saveOnboarding = async () => {
    setSaving(true)
    setMessage('')

    const { error } = await supabase
      .from('onboarding')
      .upsert(
        {
          client_id: clientId,
          ...form,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'client_id',
        }
      )

    if (error) {
      setMessage(`Error: ${error.message}`)
    } else {
      setMessage('Onboarding information saved.')
    }

    setSaving(false)
  }

  if (!open) {
    return (
      <button
        className="btn btnOutline"
        type="button"
        onClick={() => setOpen(true)}
      >
        Onboard Client
      </button>
    )
  }

  return (
    <div
      style={{
        marginTop: '18px',
        paddingTop: '18px',
        borderTop: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <h3>Onboard {companyName}</h3>

      <div className="adminCreateForm">
        <label>
          Business Phone
          <input
            value={form.business_phone}
            onChange={(e) =>
              updateField('business_phone', e.target.value)
            }
            placeholder="+1 416..."
          />
        </label>

        <label>
          Business Hours
          <input
            value={form.business_hours}
            onChange={(e) =>
              updateField('business_hours', e.target.value)
            }
            placeholder="Mon-Fri 8am-6pm"
          />
        </label>

        <label>
          Services
          <textarea
            value={form.services}
            onChange={(e) =>
              updateField('services', e.target.value)
            }
            placeholder="List the services this business provides"
          />
        </label>

        <label>
          Pricing Information
          <textarea
            value={form.pricing_notes}
            onChange={(e) =>
              updateField('pricing_notes', e.target.value)
            }
            placeholder="Pricing the receptionist is allowed to discuss"
          />
        </label>

        <label>
          Service Area
          <input
            value={form.service_area}
            onChange={(e) =>
              updateField('service_area', e.target.value)
            }
            placeholder="Toronto, GTA..."
          />
        </label>

        <label>
          FAQs
          <textarea
            value={form.faqs}
            onChange={(e) =>
              updateField('faqs', e.target.value)
            }
            placeholder="Common questions and approved answers"
          />
        </label>

        <label>
          Human Transfer Number
          <input
            value={form.transfer_number}
            onChange={(e) =>
              updateField('transfer_number', e.target.value)
            }
            placeholder="+1 416..."
          />
        </label>

        <label>
          Emergency / Urgent Call Rules
          <textarea
            value={form.emergency_rules}
            onChange={(e) =>
              updateField('emergency_rules', e.target.value)
            }
            placeholder="When should the AI transfer the caller?"
          />
        </label>

        <label>
          Appointment Types
          <textarea
            value={form.appointment_types}
            onChange={(e) =>
              updateField('appointment_types', e.target.value)
            }
            placeholder="Consultation, service call, estimate..."
          />
        </label>

        <label>
          Appointment Lengths
          <input
            value={form.appointment_lengths}
            onChange={(e) =>
              updateField('appointment_lengths', e.target.value)
            }
            placeholder="Consultation: 30 min"
          />
        </label>

        <label>
          Cancellation Rules
          <textarea
            value={form.cancellation_rules}
            onChange={(e) =>
              updateField('cancellation_rules', e.target.value)
            }
            placeholder="Cancellation and rescheduling rules"
          />
        </label>

        <label>
          Receptionist Tone
          <input
            value={form.tone_preference}
            onChange={(e) =>
              updateField('tone_preference', e.target.value)
            }
            placeholder="Friendly, professional, concise..."
          />
        </label>

        <label>
          Voice Preference
          <input
            value={form.voice_preference}
            onChange={(e) =>
              updateField('voice_preference', e.target.value)
            }
            placeholder="Male/female, warm, professional..."
          />
        </label>

        <label>
          Topics AI Must Not Discuss
          <textarea
            value={form.forbidden_topics}
            onChange={(e) =>
              updateField('forbidden_topics', e.target.value)
            }
            placeholder="Anything the receptionist should avoid"
          />
        </label>

        <label>
          Notifications
          <textarea
            value={form.notification_preferences}
            onChange={(e) =>
              updateField(
                'notification_preferences',
                e.target.value
              )
            }
            placeholder="Who receives call summaries and booking notifications?"
          />
        </label>

        <label>
          Internal Onboarding Notes
          <textarea
            value={form.onboarding_notes}
            onChange={(e) =>
              updateField('onboarding_notes', e.target.value)
            }
            placeholder="Anything else you need when building this agent"
          />
        </label>
      </div>

      {message && <p>{message}</p>}

      <div
        style={{
          display: 'flex',
          gap: '10px',
          marginTop: '18px',
        }}
      >
        <button
          className="btn btnPrimary"
          type="button"
          onClick={saveOnboarding}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save Onboarding'}
        </button>

        <button
          className="btn btnOutline"
          type="button"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
    </div>
  )
}
