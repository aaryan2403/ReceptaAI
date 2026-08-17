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
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      aria-label="Book a Recepta discovery call"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modalCard" style={{ maxWidth: '1100px', width: '95vw' }}>
        <div className="modalHeader">
          <div className="contactHeading">
            <span className="contactHeadingIcon">
              <CalendarIcon size={20} />
            </span>

            <div>
              <div className="contactTitle">Book a Recepta Discovery Call</div>
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

        <iframe
          src="https://cal.com/recepta/30min?embed=true&theme=dark"
          title="Recepta Discovery Call"
          style={{
            width: '100%',
            height: '700px',
            border: '0',
            borderRadius: '16px',
          }}
        />
      </div>
    </div>
  )
}
