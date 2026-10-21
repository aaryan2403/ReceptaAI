import { useEffect } from 'react'
import { CalendarIcon } from './icons'
import { DISCOVERY_CALL_URL } from '../lib/publicCompany'

export default function ContactModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div
      className="modalOverlay bookingOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Book a Recepta discovery call"
    >
      <div
        className="modalCard bookingModalCard"
        style={{
          width: '92vw',
          maxWidth: '960px',
          maxHeight: '90vh',
          overflow: 'hidden',
        }}
      >
        <div className="modalHeader">
          <div className="contactHeading">
            <span className="contactHeadingIcon">
              <CalendarIcon size={20} />
            </span>

            <div>
              <div className="contactTitle">
                Book a Recepta Discovery Call
              </div>

              <div className="contactSubtitle">
                Choose a time that works for you.
              </div>
            </div>
          </div>

          <button
            className="modalClose"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div
          className="bookingCalendarWrap"
          style={{
            width: '100%',
            height: '530px',
            minHeight: '450px',
            overflow: 'hidden',
            borderRadius: '14px',
            background: '#050806',
          }}
        >
          <iframe
            src={`${DISCOVERY_CALL_URL}?embed=true&theme=dark&layout=month_view`}
            title="Recepta Discovery Call"
            className="bookingCalendar"
            style={{
              width: '100%',
              height: '100%',
              border: '0',
              display: 'block',
            }}
          />
        </div>
        <a className="marketingCalendarFallback" href={DISCOVERY_CALL_URL} target="_blank" rel="noreferrer">Calendar not loading? Open the discovery-call booking ↗</a>
      </div>
    </div>
  )
}
