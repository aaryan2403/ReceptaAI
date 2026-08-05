import { useEffect, useRef, useState } from 'react'
import { CalendarIcon, CheckIcon, CopyIcon, MailIcon, PhoneIcon } from './icons'

export const CONTACT_PHONE = '+1 647 963 1595'
export const CONTACT_EMAIL = 'receptahelp02@gmail.com'

type Method = 'phone' | 'email'

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    // clipboard API needs a secure context, fall back to a hidden textarea
    const field = document.createElement('textarea')
    field.value = value
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(field)
    return ok
  }
}

export default function ContactModal({ onClose }: { onClose: () => void }) {
  const [copied, setCopied] = useState<Method | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(timer.current)
    }
  }, [onClose])

  const handleCopy = async (method: Method, value: string) => {
    const ok = await copyText(value)
    if (!ok) return

    setCopied(method)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Book an appointment"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modalCard">
        <div className="modalHeader">
          <div className="contactHeading">
            <span className="contactHeadingIcon">
              <CalendarIcon size={20} />
            </span>
            <div>
              <div className="contactTitle">Book an appointment</div>
              <div className="contactSubtitle">Call or email us, and we'll find a slot that works.</div>
            </div>
          </div>
          <button className="modalClose" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="contactMethods">
          <button
            className={`contactMethod ${copied === 'phone' ? 'contactMethod--copied' : ''}`}
            type="button"
            onClick={() => handleCopy('phone', CONTACT_PHONE)}
          >
            <span className="contactIcon">
              <PhoneIcon size={18} />
            </span>
            <span className="contactDetail">
              <span className="contactLabel">Phone</span>
              <span className="contactValue">{CONTACT_PHONE}</span>
            </span>
            <span className="contactCopy">
              {copied === 'phone' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              {copied === 'phone' ? 'Copied' : 'Copy'}
            </span>
          </button>

          <button
            className={`contactMethod ${copied === 'email' ? 'contactMethod--copied' : ''}`}
            type="button"
            onClick={() => handleCopy('email', CONTACT_EMAIL)}
          >
            <span className="contactIcon">
              <MailIcon size={18} />
            </span>
            <span className="contactDetail">
              <span className="contactLabel">Email</span>
              <span className="contactValue">{CONTACT_EMAIL}</span>
            </span>
            <span className="contactCopy">
              {copied === 'email' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
              {copied === 'email' ? 'Copied' : 'Copy'}
            </span>
          </button>
        </div>

        <p className="contactHint" role="status">
          {copied ? 'Copied to your clipboard.' : 'Tap either one to copy it to your clipboard.'}
        </p>

        <div className="modalActions">
          <button className="btn btnOutline btnLg" type="button" onClick={onClose}>
            Close
          </button>
          <a className="btn btnPrimary btnLg" href={`tel:${CONTACT_PHONE.replace(/\s+/g, '')}`}>
            <PhoneIcon size={17} />
            Call now
          </a>
        </div>
      </div>
    </div>
  )
}
