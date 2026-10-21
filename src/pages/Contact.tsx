import { ArrowDown, ArrowUpRight, CalendarDays, Check, Mail, MapPin, MessageSquare } from 'lucide-react'
import MarketingLayout from '../components/MarketingLayout'
import { DISCOVERY_CALL_URL, RECEPTA_EMAIL } from '../lib/publicCompany'

export default function Contact() {
  return <MarketingLayout title="Contact Us" description="Talk to Recepta about an AI receptionist for your business. Email Recepta or book a discovery call to discuss call answering, setup and pricing.">
    <section className="marketingContainer marketingContactHero">
      <span className="marketingEyebrow">GOOD CONVERSATIONS START HERE</span>
      <h1>Let’s talk<br /><span>about your next hello.</span></h1>
      <div className="marketingContactIntro"><p>Have a busy phone, a few questions, or an idea for your business? You’re in the right place.</p><span><MapPin size={16} /> Toronto, Canada</span></div>
      <div className="marketingContactOptions">
        <a className="marketingContactOption" href={`mailto:${RECEPTA_EMAIL}`}><span className="marketingContactIcon"><Mail size={26} strokeWidth={1.5} /></span><span className="marketingEyebrow">WRITE TO US</span><h2>A question.<br />An idea. A hello.</h2><p>For product questions, setup, existing-client support, or anything else Recepta.</p><strong>{RECEPTA_EMAIL}<ArrowUpRight size={20} /></strong></a>
        <a className="marketingContactOption marketingContactBooking" href={DISCOVERY_CALL_URL} target="_blank" rel="noreferrer"><span className="marketingContactIcon"><CalendarDays size={26} strokeWidth={1.5} /></span><span className="marketingEyebrow">MAKE SOME TIME</span><h2>Your business.<br />Our undivided attention.</h2><p>A discovery call to understand your calls, explore the product and work out the right fit.</p><strong>Book a discovery call <ArrowUpRight size={20} /></strong><span className="marketingDuration">30 minutes · Online</span></a>
      </div>
    </section>
    <section className="marketingContainer marketingSection marketingContactAgenda"><div><span className="marketingEyebrow">NO NEED TO HAVE ALL THE ANSWERS</span><h2>Bring your business.<br /><span>We’ll bring the questions.</span></h2></div><div><p>We’ll use the discovery call to get practical about your day-to-day work.</p><ul className="marketingCheckList"><li><Check /> What customers usually call you about</li><li><Check /> The calls and details your team needs most</li><li><Check /> Your current number, hours and call volume</li><li><Check /> The right plan, full pricing and setup steps</li></ul><a className="marketingTextLink" href="#book-call">Choose a time below <ArrowDown size={16} /></a></div></section>
    <section className="marketingCalendarSection" id="book-call"><div className="marketingContainer"><div className="marketingSectionHead"><span className="marketingEyebrow">LET’S PUT A CONVERSATION ON THE CALENDAR</span><h2>A time that<br /><span>works for you.</span></h2><p>Use the same Recepta discovery-call calendar here, or open it in a new tab.</p></div><div className="marketingCalendarFrame"><iframe src={`${DISCOVERY_CALL_URL}?embed=true&theme=dark&layout=month_view`} title="Book a Recepta discovery call" loading="lazy" /><a href={DISCOVERY_CALL_URL} target="_blank" rel="noreferrer">Open the discovery-call calendar <ArrowUpRight size={15} /></a></div></div></section>
    <section className="marketingContainer marketingSupportNote"><MessageSquare size={23} /><div><h2>Already a Recepta customer?</h2><p>Email us with your business name and what you need help with. You can also use Customer Requests in your dashboard.</p></div><a href="/login" className="marketingTextLink">Customer Login <ArrowUpRight size={16} /></a></section>
  </MarketingLayout>
}
