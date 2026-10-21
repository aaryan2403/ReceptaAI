import { CalendarIcon, ArrowRightIcon } from './icons'

export default function Hero({ onBook }: { onBook: () => void }) {
  return (
    <section className="hero heroNew" id="top">
      <div className="container heroNewInner">
        <div className="heroNewGlow" />

        <div className="heroNewContent">
          <div className="heroNewEyebrow">
            AI RECEPTIONIST FOR MODERN BUSINESSES
          </div>

          <h1 className="heroNewTitle">RECEPTA</h1>

          <p className="heroNewSubtitle">
            A clear first response. A captured next step.
          </p>

          <p className="heroNewDescription">
            Recepta answers configured customer calls, handles enquiries, captures appointment requests,
            and keeps useful details ready for your team’s follow-up.
          </p>

          <div className="heroNewCtas">
            <button className="btn btnPrimary btnLg" type="button" onClick={onBook}>
              <CalendarIcon size={18} />
              Book a Demo
            </button>

            <a className="btn btnOutline btnLg" href="/our-product">
              See How It Works
              <ArrowRightIcon size={18} />
            </a>
          </div>

          <div className="heroNewProof">
            <span>24/7 call answering</span>
            <span className="heroProofDot" />
            <span>Appointment requests</span>
            <span className="heroProofDot" />
            <span>Clear follow-up</span>
          </div>
        </div>
      </div>
    </section>
  )
}
