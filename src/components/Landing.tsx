import type { ComponentType, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import Hero from './Hero'
import Navbar from './Navbar'
import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GlobeIcon,
  HomeIcon,
  LayersIcon,
  MessageIcon,
  PhoneIcon,
  QuoteIcon,
  RefreshIcon,
  ScaleIcon,
  ShieldIcon,
  ShuffleIcon,
  SparklesIcon,
  SprayIcon,
  StethoscopeIcon,
  ThermometerIcon,
  TrendingUpIcon,
  WrenchIcon,
  ZapIcon,
} from './icons'
import useTilt from '../hooks/useTilt'

type IconComponent = ComponentType<{ size?: number; className?: string }>

function FeatureCard({
  title,
  description,
  icon: Icon,
}: {
  title: string
  description: string
  icon: IconComponent
}) {
  const tilt = useTilt(10)

  return (
    <div className="featureCard" ref={tilt.ref} onMouseMove={tilt.onMouseMove} onMouseLeave={tilt.onMouseLeave}>
      <div className="featureIcon">
        <Icon size={20} />
      </div>
      <div className="featureTitle">{title}</div>
      <div className="featureDesc">{description}</div>
    </div>
  )
}

function WorkCard({
  name,
  category,
  blurb,
  tags,
  domain,
  accent,
}: {
  name: string
  category: string
  blurb: string
  tags: string[]
  domain: string
  accent: string
}) {
  const tilt = useTilt(8)

  return (
    <article className="workCard" ref={tilt.ref} onMouseMove={tilt.onMouseMove} onMouseLeave={tilt.onMouseLeave}>
      <div className="workThumb" style={{ background: accent }}>
        <div className="workChrome" aria-hidden="true">
          <span className="workDot" />
          <span className="workDot" />
          <span className="workDot" />
          <span className="workUrl">
            <GlobeIcon size={12} />
            {domain}
          </span>
        </div>
        <div className="workMark" aria-hidden="true">
          {name.charAt(0)}
        </div>
      </div>

      <div className="workBody">
        <div className="workCategory">
          <LayersIcon size={13} />
          {category}
        </div>
        <h3 className="workName">{name}</h3>
        <p className="workBlurb">{blurb}</p>
        <div className="workTags">
          {tags.map((tag) => (
            <span key={tag} className="workTag">
              {tag}
            </span>
          ))}
        </div>
        <a className="workLink" href={`https://${domain}`} target="_blank" rel="noreferrer">
          Visit site
          <ExternalLinkIcon size={14} />
        </a>
      </div>
    </article>
  )
}

function TiltCard({ className, children }: { className: string; children: ReactNode }) {
  const tilt = useTilt(10)

  return (
    <div className={className} ref={tilt.ref} onMouseMove={tilt.onMouseMove} onMouseLeave={tilt.onMouseLeave}>
      {children}
    </div>
  )
}

export default function Landing() {
  const pricingPlans = [
    {
      name: 'With Appointments',
      monthly: '$300/month',
      summary: [
        'Appointment booking + full call handling',
        '24/7 availability',
        '+$50/month per additional number',
      ],
      details: [
        'Appointment booking + full call information handling',
        'Ongoing maintenance and support included',
        '24/7 availability',
        'Call transfer functionality',
        'Additional phone number integration: $50/month per number',
        'Perfect for: Service-oriented businesses managing calls and schedules',
      ],
    },
    {
      name: 'Without Appointments',
      monthly: '$200/month',
      summary: [
        'Call handling and information calls',
        '24/7 availability',
        '+$50/month per additional number',
      ],
      details: [
        'Handles information and general calls',
        'Ongoing maintenance and support included',
        '24/7 availability',
        'Call transfer functionality',
        'Additional phone number integration: $50/month per number',
        'Perfect for: Businesses that want around-the-clock call coverage without booking',
      ],
    },
  ]

  const industries = [
    {
      name: 'Plumbing',
      icon: WrenchIcon as IconComponent,
      bestFor: 'Emergency + residential calls',
      typicalLift: 'More booked jobs',
    },
    {
      name: 'Dental',
      icon: StethoscopeIcon as IconComponent,
      bestFor: 'High-volume appointment desks',
      typicalLift: 'Fewer no-shows',
    },
    {
      name: 'Real estate',
      icon: HomeIcon as IconComponent,
      bestFor: 'Inbound buyer + seller inquiries',
      typicalLift: 'Faster lead response',
    },
    {
      name: 'Legal',
      icon: ScaleIcon as IconComponent,
      bestFor: 'Intake-heavy practice teams',
      typicalLift: 'More qualified consultations',
    },
    {
      name: 'Cleaning',
      icon: SprayIcon as IconComponent,
      bestFor: 'Recurring service bookings',
      typicalLift: 'Higher retention rate',
    },
    {
      name: 'HVAC',
      icon: ThermometerIcon as IconComponent,
      bestFor: 'Urgent service coordination',
      typicalLift: 'Better dispatch speed',
    },
  ]

  const work = [
    {
      name: 'Shivora',
      category: 'Brand + commerce',
      blurb:
        'A full storefront rebuild with a calmer product story, faster checkout, and a booking flow wired straight into their calendar.',
      tags: ['Web design', 'E-commerce', 'Booking flow'],
      domain: 'myshivora.com',
      accent: 'linear-gradient(135deg, rgba(0, 200, 83, 0.28), rgba(0, 120, 60, 0.10))',
    },
  ]
  const [activeIndustry, setActiveIndustry] = useState(0)
  const [openPlan, setOpenPlan] = useState<number | null>(null)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setActiveIndustry((current) => (current + 1) % industries.length)
    }, 5000)

    return () => window.clearInterval(interval)
  }, [industries.length])

  const activeDetails = industries[activeIndustry]

  return (
    <>
      <Navbar />
      <main>
        <Hero />

        <section className="section" id="product">
          <div className="container">
            <div className="sectionHeader">
              <div className="eyebrow">
                <SparklesIcon size={14} />
                Product
              </div>
              <h2 className="sectionTitle">Everything you need to turn missed calls into captured opportunities.</h2>
              <p className="sectionSubtitle">
                Designed for precision, reliability, and real business impact, so every caller feels heard, and every
                interaction drives value.
              </p>
            </div>

            <div className="featureGrid">
              <FeatureCard
                icon={PhoneIcon}
                title="Intelligent call handling"
                description="Clear, structured conversations that answer questions, qualify leads, and guide callers smoothly without confusion."
              />
              <FeatureCard
                icon={CalendarIcon}
                title="Appointment booking that actually works"
                description="Real-time scheduling aligned with your availability, reducing friction and eliminating back-and-forth."
              />
              <FeatureCard
                icon={SparklesIcon}
                title="On-brand communication, every time"
                description="Your tone. Your messaging. Your process. Delivered consistently across every call."
              />
              <FeatureCard
                icon={ShuffleIcon}
                title="Smart call transfers"
                description="Instant routing to the right team member when human attention is required, no awkward delays."
              />
              <FeatureCard
                icon={MessageIcon}
                title="Automated follow-ups"
                description="SMS and email workflows that confirm bookings, send reminders, and keep prospects engaged."
              />
              <FeatureCard
                icon={FileTextIcon}
                title="Actionable call summaries"
                description="Clean, structured notes with intent, key details, and next steps, ready for your CRM or internal team."
              />
              <FeatureCard
                icon={ShieldIcon}
                title="Scalable phone coverage"
                description="Multiple numbers, 24/7 availability, and configurable business-hour logic to match your operations."
              />
              <FeatureCard
                icon={RefreshIcon}
                title="Continuous refinement"
                description="Ongoing revision rounds to adapt scripts, flows, and automation as your business evolves."
              />
            </div>

            <div className="sectionOutro">
              <p className="sectionOutroLine">
                <ZapIcon size={15} className="outroIcon" />
                Built to remove friction.
              </p>
              <p className="sectionOutroLine">
                <TrendingUpIcon size={15} className="outroIcon" />
                Built to increase conversions.
              </p>
              <p className="sectionOutroLine">
                <ShieldIcon size={15} className="outroIcon" />
                Built so you never miss revenue again.
              </p>
            </div>

            <div className="sectionCtaRow" id="demo">
              <a className="btn btnPrimary btnLg" href="#book">
                <CalendarIcon size={18} />
                Book Appointment
              </a>
              <a className="btn btnOutline btnLg" href="#industries">
                Explore industries
                <ArrowRightIcon size={18} />
              </a>
            </div>
          </div>
        </section>

        <section className="section" id="industries">
          <div className="container">
            <div className="split">
              <div>
                <div className="eyebrow">
                  <LayersIcon size={14} />
                  Industries
                </div>
                <h2 className="sectionTitle">Fits your industry, without feeling generic.</h2>
                <p className="sectionSubtitle">
                  From home services to clinics, Recepta keeps calls structured, calm, and conversion-first.
                </p>

                <ul className="checkList">
                  <li>
                    <CheckIcon size={16} className="checkListIcon" />
                    Scripts tuned to how your callers actually ask for things
                  </li>
                  <li>
                    <CheckIcon size={16} className="checkListIcon" />
                    Escalation rules for emergencies and high-value leads
                  </li>
                  <li>
                    <CheckIcon size={16} className="checkListIcon" />
                    Booking logic that respects your real availability
                  </li>
                </ul>
              </div>

              <TiltCard className="panel">
                <div className="panelHead">
                  <span className="panelHeadIcon">
                    <activeDetails.icon size={18} />
                  </span>
                  <span className="panelHeadName">{activeDetails.name}</span>
                </div>

                <div className="panelRow">
                  <div className="panelItem">
                    <div className="panelLabel">
                      <ShieldIcon size={12} />
                      Best for
                    </div>
                    <div className="panelValue">{activeDetails.bestFor}</div>
                  </div>
                  <div className="panelItem">
                    <div className="panelLabel">
                      <TrendingUpIcon size={12} />
                      Typical lift
                    </div>
                    <div className="panelValue">{activeDetails.typicalLift}</div>
                  </div>
                </div>

                <div className="chipGrid">
                  {industries.map((industry, index) => (
                    <button
                      key={industry.name}
                      type="button"
                      className={`chip ${index === activeIndustry ? 'chipActive' : ''}`}
                      onClick={() => setActiveIndustry(index)}
                    >
                      <industry.icon size={13} />
                      {industry.name}
                    </button>
                  ))}
                </div>
              </TiltCard>
            </div>
          </div>
        </section>

        {/* ===== WORK / PORTFOLIO ===== */}
        <section className="section" id="work">
          <div className="container">
            <div className="sectionHeader">
              <div className="eyebrow">
                <GlobeIcon size={14} />
                Selected work
              </div>
              <h2 className="sectionTitle">Websites we've built, and the calls they now capture.</h2>
              <p className="sectionSubtitle">
                We design the site, then wire the phone line into it, so traffic and calls land in the same place your
                team already works.
              </p>
            </div>

            <div className="workGrid">
              {work.map((project) => (
                <WorkCard key={project.name} {...project} />
              ))}
            </div>

            <div className="workQuote">
              <QuoteIcon size={22} className="workQuoteIcon" />
              <p className="workQuoteText">
                The new site looked great on day one, but the real change was the phone. Nothing rings out anymore.
              </p>
              <div className="workQuoteAuthor">Operations lead, Shivora</div>
            </div>

            <div className="sectionCtaRow">
              <a className="btn btnPrimary btnLg" href="#book">
                <CalendarIcon size={18} />
                Book Appointment
              </a>
              <a className="btn btnOutline btnLg" href="#pricing">
                See pricing
                <ArrowRightIcon size={18} />
              </a>
            </div>
          </div>
        </section>

        <section className="section" id="pricing">
          <div className="container">
            <div className="sectionHeader">
              <div className="eyebrow">
                <ZapIcon size={14} />
                Pricing
              </div>
              <h2 className="sectionTitle">Simple pricing. Premium experience.</h2>
              <p className="sectionSubtitle">Start with AI. Add humans when you want the extra touch.</p>
            </div>

            <div className="pricingGrid">
              {pricingPlans.map((plan, index) => (
                <TiltCard key={plan.name} className="pricingCard">
                  <div className="pricingHead">
                    <span className="pricingIcon">
                      {index === 0 ? <CalendarIcon size={18} /> : <PhoneIcon size={18} />}
                    </span>
                    <div className="pricingName">{plan.name}</div>
                  </div>
                  <div className="pricingPrice">{plan.monthly}</div>
                  <div className="pricingDesc">{plan.summary[0]}</div>
                  <ul className="pricingBullets">
                    {plan.summary.slice(0, 3).map((point) => (
                      <li key={point}>
                        <CheckIcon size={15} className="pricingBulletIcon" />
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                  <button className="btn btnOutline btnLg" type="button" onClick={() => setOpenPlan(index)}>
                    <FileTextIcon size={17} />
                    View details
                  </button>
                  <a className="btn btnPrimary btnLg" href="#book">
                    <CalendarIcon size={17} />
                    Book Appointment
                  </a>
                </TiltCard>
              ))}
            </div>
            <p className="sectionSubtitle" style={{ marginTop: '24px', textAlign: 'center' }}>
              Need more phone numbers? Add any number to your plan for $50/month each.
            </p>
          </div>
        </section>

        {/* ===== BOOK APPOINTMENT ===== */}
        <section className="section" id="book">
          <div className="container">
            <div className="bookCard">
              <div className="bookIcon">
                <CalendarIcon size={26} />
              </div>
              <h2 className="sectionTitle">Book an appointment with us.</h2>
              <p className="sectionSubtitle">
                Thirty minutes. We map your call flow, show you the agent handling a real scenario from your industry,
                and tell you exactly what setup would look like.
              </p>

              <div className="bookPoints">
                <div className="bookPoint">
                  <CheckIcon size={16} className="proofIcon" />
                  <span>30 minutes, no prep needed</span>
                </div>
                <div className="bookPoint">
                  <CheckIcon size={16} className="proofIcon" />
                  <span>Live agent walkthrough</span>
                </div>
                <div className="bookPoint">
                  <CheckIcon size={16} className="proofIcon" />
                  <span>Written setup plan afterwards</span>
                </div>
              </div>

              <div className="sectionCtaRow">
                <a className="btn btnPrimary btnLg" href="#book">
                  <CalendarIcon size={18} />
                  Book Appointment
                </a>
                <a className="btn btnOutline btnLg" href="#demo">
                  <PhoneIcon size={18} />
                  Talk to AI right now
                </a>
              </div>
            </div>
          </div>
        </section>

        {openPlan !== null && (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label={`${pricingPlans[openPlan].name} details`}>
            <div className="modalCard">
              <div className="modalHeader">
                <div>
                  <div className="pricingName">{pricingPlans[openPlan].name}</div>
                  <div className="pricingPrice">{pricingPlans[openPlan].monthly}</div>
                </div>
                <button className="modalClose" type="button" onClick={() => setOpenPlan(null)} aria-label="Close">
                  ×
                </button>
              </div>
              <ul className="modalList">
                {pricingPlans[openPlan].details.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className="modalActions">
                <button className="btn btnOutline btnLg" type="button" onClick={() => setOpenPlan(null)}>
                  Close
                </button>
                <a className="btn btnPrimary btnLg" href="#book" onClick={() => setOpenPlan(null)}>
                  <CalendarIcon size={17} />
                  Book Appointment
                </a>
              </div>
            </div>
          </div>
        )}

        <footer className="footer" id="company">
          <div className="container footerInner">
            <img className="footerLogo" src="/components/logoR.png" alt="Recepta" />

            <nav className="footerLinks" aria-label="Footer">
              <a className="footerLink" href="#product">
                <SparklesIcon size={14} />
                Product
              </a>
              <a className="footerLink" href="#industries">
                <LayersIcon size={14} />
                Industries
              </a>
              <a className="footerLink" href="#work">
                <GlobeIcon size={14} />
                Our work
              </a>
              <a className="footerLink" href="#pricing">
                <ZapIcon size={14} />
                Pricing
              </a>
              <a className="footerLink" href="#book">
                <CalendarIcon size={14} />
                Book Appointment
              </a>
            </nav>

            <div className="footerText">© {new Date().getFullYear()} Recepta. Less hassle, more hustle.</div>
          </div>
        </footer>
      </main>
    </>
  )
}
