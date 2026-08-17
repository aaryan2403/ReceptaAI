import { useEffect } from 'react'
import { CalendarIcon } from './icons'

const BOOKING_URL = 'https://cal.com/recepta/30min'

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
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Book a Recepta discovery call"
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
              <div className="contactTitle">Book a Recepta Discovery Call</div>
              <div className="contactSubtitle">
                Choose a time that works for you and see how Recepta can help your business.
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

        <div className="modalActions">
          <button
            className="btn btnOutline btnLg"
            type="button"
            onClick={onClose}
          >
            Close
          </button>

          <a
            className="btn btnPrimary btnLg"
            href={BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <CalendarIcon size={17} />
            Choose a Time
          </a>
        </div>
      </div>
    </div>
  )
}
