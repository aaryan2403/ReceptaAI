import { useEffect, useRef, useState } from 'react'
import { CalendarIcon } from './icons'

export default function Navbar({ onBook }: { onBook: () => void }) {
  const [isHidden, setIsHidden] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)
  const lastScroll = useRef(0)

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY
      setIsScrolled(y > 8)
      if (y > lastScroll.current && y > 120) {
        setIsHidden(true)
      } else {
        setIsHidden(false)
      }
      lastScroll.current = y
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`nav ${isHidden ? 'nav--hidden' : ''} ${isScrolled ? 'nav--solid' : ''}`}>
      <div className="container navInner">
        <a className="navBrand" href="#top" aria-label="Recepta home">
          <img className="navLogo" src="/components/logoR.png" alt="Recepta" />
        </a>

        <nav className="navLinks" aria-label="Primary">
          <a className="navLink" href="#product">
            Product
          </a>
          <a className="navLink" href="#industries">
            Industries
          </a>
          <a className="navLink" href="#work">
            Our work
          </a>
          <a className="navLink" href="#pricing">
            Pricing
          </a>
          <a className="navLink" href="#company">
            Company
          </a>
        </nav>

        <div className="navCtas">
          <a className="btn btnGhost" href="#login">
            Log in
          </a>
          <button className="btn btnPrimary" type="button" onClick={onBook}>
            <CalendarIcon size={16} />
            Book a Demo
          </button>
        </div>
      </div>
    </header>
  )
}
