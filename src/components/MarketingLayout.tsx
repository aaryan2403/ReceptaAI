import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, ArrowRight } from 'lucide-react'
import Navbar from './Navbar'
import ContactModal from './ContactModal'
import { DISCOVERY_CALL_URL, RECEPTA_EMAIL } from '../lib/publicCompany'
import '../App.css'
import './Marketing.css'

export default function MarketingLayout({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const [booking, setBooking] = useState(false)
  useEffect(() => {
    const oldTitle = document.title
    const meta = document.querySelector('meta[name="description"]')
    const oldDescription = meta?.getAttribute('content')
    document.title = `${title} | Recepta`
    meta?.setAttribute('content', description)
    const scrollFrame = requestAnimationFrame(() => {
      const target = window.location.hash && document.getElementById(window.location.hash.slice(1))
      if (target) target.scrollIntoView()
      else window.scrollTo(0, 0)
    })
    return () => { cancelAnimationFrame(scrollFrame); document.title = oldTitle; if (oldDescription) meta?.setAttribute('content', oldDescription) }
  }, [title, description])
  return <div className="marketingPage">
    <a className="marketingSkip" href="#main-content">Skip to content</a>
    <Navbar onBook={() => setBooking(true)} />
    <main id="main-content">{children}</main>
    <footer className="marketingFooter">
      <div className="marketingContainer marketingFooterTop">
        <div><a href="/" aria-label="Recepta home"><img src="/components/logoR.png" alt="Recepta" /></a><p>A better first hello.<br />A clearer next step.</p><span>Built for the businesses that keep homes running.</span></div>
        <div><h2>Explore</h2><a href="/our-product">Our Product</a><a href="/our-product#plans">Plans & pricing</a><a href="/about">About Us</a></div>
        <div><h2>Let’s talk</h2><a href="/contact">Contact Us</a><a href={DISCOVERY_CALL_URL} target="_blank" rel="noreferrer">Book a discovery call <ArrowUpRight size={14} /></a><a href={`mailto:${RECEPTA_EMAIL}`}>Email Recepta <ArrowUpRight size={14} /></a></div>
      </div>
      <div className="marketingContainer marketingFooterBottom"><span>© {new Date().getFullYear()} Recepta · Toronto, Canada</span><div><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/login">Customer Login</a></div></div>
    </footer>
    {booking && <ContactModal onClose={() => setBooking(false)} />}
  </div>
}

export function MarketingCTA({ label = 'Let’s build your better first hello.' }: { label?: string }) {
  return <section className="marketingContainer marketingClosing"><div><span className="marketingEyebrow">YOUR NEXT CALL COULD BE YOUR NEXT CUSTOMER</span><h2>{label}</h2><p>Tell us how your business works. We’ll walk you through where Recepta fits.</p></div><a className="marketingButton" href="/contact">Let’s talk <ArrowRight size={18} /></a></section>
}
