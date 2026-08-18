import { useEffect } from 'react'
import { CalendarIcon } from './icons'

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
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modalCard"
        style={{
          width: '92vw',
          maxWidth: '1050px',
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
          style={{
            height: '560px',
            width: '100%',
            overflow: 'hidden',
            borderRadius: '14px',
            background: '#0a0a0a',
          }}
        >
          <iframe
            src="https://cal.com/recepta/30min?embed=true&theme=dark&layout=month_view"
            title="Recepta Discovery Call"
            style={{
              width: '100%',
              height: '100%',
              border: '0',
              display: 'block',
            }}
          />
        </div>
      </div>
    </div>
  )
}
