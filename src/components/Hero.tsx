import type { ComponentType } from 'react'
import {
  BotIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  MessageIcon,
  PhoneIcon,
  ShuffleIcon,
  SparklesIcon,
  TrendingUpIcon,
  ZapIcon,
} from './icons'

type Step = {
  title: string
  text: string
  icon: ComponentType<{ size?: number; className?: string }>
}

const steps: Step[] = [
  {
    title: 'Call comes in',
    text: 'Any hour, any volume. Nights, weekends, and the three calls that land at once all get picked up. Nothing rings out.',
    icon: PhoneIcon,
  },
  {
    title: 'Instant pickup',
    text: 'Answered in under a second, in your brand’s voice, with the greeting and tone you signed off on.',
    icon: ZapIcon,
  },
  {
    title: 'Understand the intent',
    text: 'Works out what the caller actually needs, how urgent it is, and whether they are a fit for what you do.',
    icon: BotIcon,
  },
  {
    title: 'Answer or qualify',
    text: 'Handles hours, pricing, and service questions directly, and asks the qualifying questions your team would ask.',
    icon: MessageIcon,
  },
  {
    title: 'Book or transfer',
    text: 'Writes the appointment straight into your real calendar, or routes the call to a human the moment it matters.',
    icon: CalendarIcon,
  },
  {
    title: 'Confirm and follow up',
    text: 'SMS and email confirmations go out automatically, with reminders that cut down on no-shows.',
    icon: CheckIcon,
  },
  {
    title: 'Summary to your team',
    text: 'Structured notes with intent, key details, and next steps, ready to drop into your CRM.',
    icon: FileTextIcon,
  },
]

export default function Hero() {
  return (
    <section className="hero" id="top">
      <div className="container">
        <div className="heroLeft">
          <div className="badge">
            <SparklesIcon size={18} className="badgeIcon" />
            <span>AI receptionist built for high-intent inbound calls</span>
          </div>

          <h1 className="heroTitle">The cleanest way to capture every call and convert more customers.</h1>

          <p className="heroSubtitle">
            Recepta answers instantly, qualifies leads, books appointments, and routes urgent requests to your team.
            Always on. Always consistent.
          </p>

          <div className="heroCtas">
            <a className="btn btnPrimary btnLg" href="#book">
              <CalendarIcon size={18} />
              Book Appointment
            </a>
            <a className="btn btnOutline btnLg" href="#demo">
              <PhoneIcon size={18} />
              Talk to AI Right now
            </a>
          </div>

          <div className="heroProof">
            <div className="proofItem">
              <CheckIcon size={18} className="proofIcon" />
              <span>24/7 instant pickup</span>
            </div>
            <div className="proofItem">
              <CheckIcon size={18} className="proofIcon" />
              <span>Lead capture + CRM-ready notes</span>
            </div>
            <div className="proofItem">
              <CheckIcon size={18} className="proofIcon" />
              <span>Human handoff when it matters</span>
            </div>
          </div>
        </div>

        {/* ===== HOW IT WORKS: call handling workflow ===== */}
        <div className="workflow" aria-label="How a call is handled">
          <div className="workflowHead">
            <div className="eyebrow">
              <ShuffleIcon size={14} />
              How it works
            </div>
            <h2 className="workflowTitle">What happens the moment someone calls.</h2>
            <p className="workflowSubtitle">
              Seven steps, start to finish, with no one on your team touching the phone unless the call genuinely needs
              them.
            </p>
          </div>

          <ol className="workflowSteps">
            {steps.map((step, index) => (
              <li className="workflowStep" key={step.title}>
                <div className="stepMarker">
                  <span className="stepNode">
                    <step.icon size={18} />
                  </span>
                </div>
                <div className="stepBody">
                  <div className="stepHead">
                    <span className="stepNumber">{String(index + 1).padStart(2, '0')}</span>
                    <h3 className="stepTitle">{step.title}</h3>
                  </div>
                  <p className="stepText">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="miniCards">
            <div className="miniCard">
              <TrendingUpIcon size={18} className="miniIcon" />
              <div className="miniKpi">+18%</div>
              <div className="miniLabel">More booked jobs</div>
            </div>
            <div className="miniCard">
              <ZapIcon size={18} className="miniIcon" />
              <div className="miniKpi">&lt;1s</div>
              <div className="miniLabel">Pickup time</div>
            </div>
            <div className="miniCard">
              <ClockIcon size={18} className="miniIcon" />
              <div className="miniKpi">24/7</div>
              <div className="miniLabel">Coverage</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
