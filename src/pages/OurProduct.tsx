import { useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, AudioLines, Bell, CalendarClock, Check, CheckCheck, Clock3, Cloud, Headphones, LayoutDashboard, ListChecks, Mail, Phone, PhoneIncoming, PhoneMissed, Plus, Settings2, ShieldCheck, SlidersHorizontal, Wrench } from 'lucide-react'
import MarketingLayout, { MarketingCTA } from '../components/MarketingLayout'
import PublicPricing from '../components/PublicPricing'
import { EXTRA_PHONE_NUMBER_MONTHLY_CAD, PII_REDACTION_PER_MINUTE_CAD, SAFETY_GUARDRAILS_PER_MINUTE_CAD, STANDARD_BASE_MONTHLY_CAD, PRO_BASE_MONTHLY_CAD } from '../../netlify/lib/pricing'

const examples = [
  { name: 'Answer an enquiry', icon: PhoneIncoming, title: 'A helpful first response.', description: 'Your receptionist answers from the business information we configure together: services, service areas, opening hours and approved answers.', question: 'Do you service furnaces in North York?', answer: 'Yes, North York is in our service area. Could you tell me what’s happening with your furnace?', outcome: 'Service enquiry captured', tag: 'Call handled', status: 'Completed', detail: 'Furnace service · North York', action: 'Review the call', Icon: CheckCheck },
  { name: 'Capture a request', icon: CalendarClock, title: 'The details your team needs.', description: 'On Pro, collect the customer’s preferred time, service, contact details and your custom intake fields. Your team checks availability and confirms the appointment.', question: 'Could someone come tomorrow afternoon?', answer: 'I can pass that preference to the team. What’s the best number to reach you on? They’ll confirm availability with you.', outcome: 'Appointment request captured', tag: 'Awaiting confirmation', status: 'Requested', detail: 'Tomorrow afternoon · Furnace inspection', action: 'Confirm with the customer', Icon: CalendarClock },
  { name: 'Follow up a missed call', icon: PhoneMissed, title: 'Give follow-up a home.', description: 'When a call cannot be admitted, Recepta records a callback request when caller details are available. Your team can mark it contacted, resolved or unreachable.', question: 'What if the AI cannot take the call?', answer: 'The callback queue keeps the caller number and decline reason available for your team to follow up.', outcome: 'Callback request recorded', tag: 'Pending callback', status: 'Pending', detail: 'Caller ID available · Follow-up needed', action: 'Call the customer back', Icon: PhoneMissed },
]

function ProductPreview() {
  const [active, setActive] = useState(0)
  const example = examples[active]
  return <div className="marketingPreview" id="product-preview">
    <div className="marketingPreviewBar"><span><i /><i /><i /></span><span><ShieldCheck size={12} /> Your Recepta workspace</span><small>ILLUSTRATIVE PREVIEW</small></div>
    <div className="marketingPreviewBody">
      <aside className="marketingPreviewSidebar" aria-hidden="true"><span className="marketingMiniLogo">r<span>.</span></span><LayoutDashboard size={18} /><Phone size={18} /><CalendarClock size={18} /><Settings2 size={18} /><span className="marketingAvatar">Y</span></aside>
      <div className="marketingPreviewContent">
        <div className="marketingPreviewHeading"><div><span>YOUR FRONT DESK, IN FOCUS</span><h3>Every call. A clear next step.</h3></div><span className="marketingStatus"><i /> Example workspace</span></div>
        <div className="marketingDemoTabs" role="group" aria-label="Explore a product example">{examples.map((item, index) => <button key={item.name} type="button" aria-pressed={active === index} onClick={() => setActive(index)}><item.icon size={16} />{item.name}</button>)}</div>
        <div className="marketingDemoGrid" aria-live="polite">
          <div className="marketingConversation"><span className="marketingSmallLabel">{active === 2 ? 'HOW FOLLOW-UP WORKS' : 'EXAMPLE CONVERSATION'}</span><div className="marketingChat marketingChatCaller"><span>{active === 2 ? 'YOU' : 'CALLER'}</span><p>{example.question}</p></div><div className="marketingChat marketingChatAI"><span><AudioLines size={13} /> RECEPTA</span><p>{example.answer}</p></div><div className="marketingWave" aria-hidden="true">{Array.from({ length: 42 }, (_, i) => <i key={i} style={{ height: `${8 + ((i * 13 + 7) % 28)}px` }} />)}</div></div>
          <div className="marketingCallDetail"><span className="marketingSmallLabel">{active === 2 ? 'CALLBACK RECORD' : 'CALL RECORD'}</span><span className="marketingDetailIcon"><example.Icon size={25} /></span><span className="marketingDetailTag">{example.tag}</span><h4>{example.outcome}</h4><p>{example.detail}</p><div><span>Status</span><strong>{example.status}</strong></div><div><span>Next step</span><strong>{example.action}</strong></div></div>
        </div>
        <div className="marketingPreviewCaption"><strong>{example.title}</strong><p>{example.description}</p></div>
      </div>
    </div>
  </div>
}

function CallNetwork() {
  return <div className="marketingNetwork" role="img" aria-label="Calls from your phone lines reach Recepta in the cloud, then become call records and owner notifications.">
    <div className="marketingNetworkLines" aria-hidden="true"><svg viewBox="0 0 900 240" preserveAspectRatio="none"><path d="M150 60 H270 Q300 60 300 90 V110 Q300 120 330 120 H450 M150 180 H270 Q300 180 300 150 V130 Q300 120 330 120 M450 120 H570 Q600 120 600 90 V70 Q600 60 630 60 H750 M450 120 H570 Q600 120 600 150 V170 Q600 180 630 180 H750" /></svg></div>
    <div className="marketingNetworkColumn"><div><Phone size={22} /><span>Your main line</span></div><div><Plus size={22} /><span>Additional lines</span></div></div>
    <div className="marketingCloud"><Cloud size={58} strokeWidth={1} /><strong>recepta<span>.</span></strong><small>Your cloud receptionist</small></div>
    <div className="marketingNetworkColumn"><div><LayoutDashboard size={22} /><span>Your dashboard</span></div><div><Bell size={22} /><span>Owner notifications</span></div></div>
  </div>
}

const capabilities = [
  { icon: AudioLines, title: 'A voice for your business', text: 'Choose a configured voice and AI model. We tailor the greeting, tone and instructions to the way you want customers welcomed.' },
  { icon: Clock3, title: 'Hours that make sense', text: 'Keep business opening hours separate from AI answering hours. Answer around the clock or during configured business hours, within your paid allowance.' },
  { icon: ListChecks, title: 'Context you can act on', text: 'Review call history, summaries and available caller details. On Pro, see appointment requests alongside the call that created them.' },
  { icon: Mail, title: 'Notifications with visibility', text: 'Receive owner emails for configured call events. Delivery tracking and retry workflows help Recepta surface failures that need attention.' },
  { icon: SlidersHorizontal, title: 'A clear allowance', text: 'Choose monthly minutes, see usage and eligible rollover, and review changes before payment. New AI calls pause when the paid allowance is exhausted.' },
  { icon: ShieldCheck, title: 'Control over call data', text: 'Optional PII redaction and Safety Guardrails are available. Call-content retention defaults to 90 days and can be configured from 7 to 365 days.' },
]

export default function OurProduct() {
  return <MarketingLayout title="Our Product" description="Explore Recepta’s AI receptionist for home service businesses: call answering, appointment requests, phone lines, dashboard, plans and transparent pricing.">
    <section className="marketingContainer marketingProductHero">
      <div className="marketingEyebrow"><span className="marketingPulse" /> THE RECEPTA PRODUCT</div>
      <h1>You’re on the job.<br /><span>We’re on the line.</span></h1>
      <p>A cloud-based AI receptionist for the businesses that keep homes running. Welcome callers, capture the details, and give your team a clear next step.</p>
      <div className="marketingHeroActions"><a href="/contact" className="marketingButton">Find your fit <ArrowUpRight size={18} /></a><a href="#product-preview" className="marketingTextLink">Take a closer look <ArrowDown size={16} /></a></div>
      <div className="marketingHeroNotes"><span><Check size={14} /> Set up for you</span><span><Check size={14} /> Your business knowledge</span><span><Check size={14} /> Ongoing support</span></div>
      <div className="marketingHeroOrbit" aria-hidden="true"><Cloud /><span>Less phone tag.<br />More getting things done.</span></div>
      <ProductPreview />
    </section>
    <div className="marketingIndustryStrip"><div className="marketingContainer"><span>BUILT AROUND YOUR WORKDAY</span><span>Plumbing</span><span>HVAC</span><span>Electrical</span><span>Cleaning</span><span>Home services</span></div></div>

    <section className="marketingContainer marketingSection" id="how-it-works">
      <div className="marketingSectionHead"><span className="marketingEyebrow">ONE CONNECTED FRONT DESK</span><h2>A phone call comes in.<br /><span>The next step comes together.</span></h2><p>A dedicated Recepta number connects your callers with your configured receptionist. The useful details come back to your team.</p></div>
      <CallNetwork />
      <div className="marketingThreeColumns">{[
        ['01', 'Connect your line', 'Use a dedicated Recepta number. If you want to keep an existing business number, we’ll review carrier forwarding or a supported connection with you.'],
        ['02', 'Make it your receptionist', 'We configure your services, hours, service areas, approved answers and intake requirements. You review the experience before going live.'],
        ['03', 'Stay close to the conversation', 'See call records and usage in your dashboard, receive configured notifications, and have your team follow up on requests and callbacks.'],
      ].map(([number, title, text]) => <article key={number}><span>{number}</span><h3>{title}</h3><p>{text}</p></article>)}</div>
    </section>

    <section className="marketingFeatureBand"><div className="marketingContainer marketingSection"><div className="marketingSectionHead marketingHeadSplit"><div><span className="marketingEyebrow">THE DETAILS MAKE THE DIFFERENCE</span><h2>More than<br /><span>“leave a message.”</span></h2></div><p>From the first hello to the follow-up, Recepta brings the essential pieces into one managed service.</p></div><div className="marketingCapabilities">{capabilities.map(item => <article key={item.title}><item.icon size={24} strokeWidth={1.5} /><h3>{item.title}</h3><p>{item.text}</p></article>)}</div></div></section>

    <section className="marketingContainer marketingSection marketingLinesSection" id="phone-lines"><div><span className="marketingEyebrow">YOUR NUMBERS. ONE WORKSPACE.</span><h2>A front desk<br /><span>without another desk.</span></h2><p>There’s no receptionist hardware to install. Recepta runs in the cloud, and your team uses the dashboard from a browser.</p><ul className="marketingCheckList"><li><Check /> One phone number included in the base service</li><li><Check /> Additional numbers on the same subscription</li><li><Check /> Separate business and AI answering hours</li><li><Check /> Callback tracking when an AI call cannot be accepted</li></ul><p className="marketingFinePrint">Existing-number forwarding depends on your carrier and may carry carrier charges. Number connection and real-call testing are part of onboarding.</p></div><div className="marketingPhoneArtwork"><div className="marketingArtworkGrid" /><div className="marketingPhone"><div className="marketingPhoneNotch" /><span className="marketingSmallLabel">YOUR BUSINESS</span><div className="marketingPhoneAvatar"><PhoneIncoming size={30} /></div><h3>A customer is calling.</h3><p>Let’s make the first hello count.</p><div className="marketingPhoneWave"><AudioLines size={70} strokeWidth={1} /></div><span className="marketingPhonePill"><Cloud size={14} /> Answered by Recepta</span><small>Illustrative call screen</small></div><span className="marketingFloatingNote"><Headphones size={18} /> Set up. Supported. Managed.</span></div></section>

    <section className="marketingContainer marketingSection" id="plans"><div className="marketingSectionHead"><span className="marketingEyebrow">TWO PLANS. YOUR WAY OF WORKING.</span><h2>Start with the coverage.<br /><span>Add the depth you need.</span></h2><p>Both plans include setup, ongoing support, one number, and your customer dashboard. Purchased minutes and selected extras are additional.</p></div>
      <div className="marketingPlans">{[
        { name: 'Standard', label: 'A HELPFUL FIRST HELLO', price: STANDARD_BASE_MONTHLY_CAD, summary: 'For businesses that need customer calls answered and enquiries captured.', features: ['AI call answering with configured business information', 'Call history and available summaries', 'Business and answering-hour settings', 'Owner email notifications and callback follow-up', 'Usage visibility and eligible paid-period rollover'] },
        { name: 'Pro', label: 'A MORE COMPLETE INTAKE', price: PRO_BASE_MONTHLY_CAD, summary: 'For teams that also want appointment preferences and detailed intake.', features: ['Everything in Standard', 'Appointment requests alongside call records', 'Your required appointment intake fields', 'Employee availability information for intake', 'Full appointment details in configured owner emails'] },
      ].map(plan => <article key={plan.name} className={plan.name === 'Pro' ? 'marketingPlan marketingPlanPro' : 'marketingPlan'}><span className="marketingEyebrow">{plan.label}</span><h3>Recepta {plan.name}</h3><div className="marketingPlanPrice">C${plan.price}<span>/ month base</span></div><p>{plan.summary}</p><ul>{plan.features.map(feature => <li key={feature}><Check size={17} />{feature}</li>)}</ul><a className="marketingButton" href="/contact">Discuss {plan.name} <ArrowUpRight size={16} /></a></article>)}</div>
      <p className="marketingPlanNote"><CalendarClock size={18} /> Pro captures appointment requests. Your team confirms availability; a request does not reserve a calendar slot.</p>
      <div className="marketingAddons"><div><span className="marketingEyebrow">MAKE IT FIT</span><h3>The right extras.<br />Clearly priced.</h3></div><article><ShieldCheck size={20} /><h4>PII Redaction</h4><p>Redact supported personal information categories from provider call data.</p><strong>C${PII_REDACTION_PER_MINUTE_CAD.toFixed(3)}<small> / purchased minute</small></strong></article><article><ShieldCheck size={20} /><h4>Safety Guardrails</h4><p>Add supported input and output safeguards to your configured agent.</p><strong>C${SAFETY_GUARDRAILS_PER_MINUTE_CAD.toFixed(3)}<small> / purchased minute</small></strong></article><article><Phone size={20} /><h4>Additional numbers</h4><p>Connect another Recepta number to the same active subscription.</p><strong>C${EXTRA_PHONE_NUMBER_MONTHLY_CAD}<small> / number / month</small></strong></article></div>
      <PublicPricing showModels />
    </section>

    <section className="marketingContainer marketingSection marketingFaq"><div><span className="marketingEyebrow">A FEW GOOD QUESTIONS</span><h2>Before<br /><span>you say hello.</span></h2></div><div>{[
      ['Do I need to build the agent myself?', 'No. Recepta is a managed service. We configure your receptionist around your business information, walk through the call experience with you, and support it after launch.'],
      ['Can I keep my current business number?', 'We can review forwarding from your existing carrier or a supported telephony connection. Your carrier’s capabilities and charges apply. We verify the setup with real calls before you rely on it.'],
      ['Can Recepta confirm an appointment automatically?', 'The current Pro workflow captures requests and preferred times. Your team checks the schedule and confirms with the customer. Automatic calendar reservations are not included in this workflow.'],
      ['What happens when I run out of minutes?', 'New AI calls pause when your paid allowance is used. Callback capture is available when caller details are provided. Eligible unused minutes roll into the next paid period, capped at one monthly allowance.'],
      ['Can I hear it before making a decision?', 'Yes. Book a discovery call and ask for a tailored voice demo. Shared browser demos last up to three minutes; regular customer calls do not have that demo-only cap.'],
    ].map(([question, answer]) => <details key={question}><summary>{question}<Plus size={18} /></summary><p>{answer}</p></details>)}</div></section>
    <div className="marketingContainer marketingServiceNote"><Wrench size={18} /><p>Need a website as well? Recepta also offers custom website work by separate quote. <a href="/contact">Tell us what you have in mind <ArrowRight size={14} /></a></p></div>
    <MarketingCTA />
  </MarketingLayout>
}
