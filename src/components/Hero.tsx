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
            Every call answered. Every appointment handled.
          </p>

          <p className="heroNewDescription">
            Recepta answers customer calls 24/7, handles enquiries, books appointments,
            and transfers important calls when your team needs to step in.
          </p>

          <div className="heroNewCtas">
            <button className="btn btnPrimary btnLg" type="button" onClick={onBook}>
              <CalendarIcon size={18} />
              Book a Demo
            </button>

            <a className="btn btnOutline btnLg" href="#product">
              See How It Works
              <ArrowRightIcon size={18} />
            </a>
          </div>

          <div className="heroNewProof">
            <span>24/7 call answering</span>
            <span className="heroProofDot" />
            <span>Appointment booking</span>
            <span className="heroProofDot" />
            <span>Human handoff</span>
          </div>
        </div>
      </div>
    </section>
  )
}
