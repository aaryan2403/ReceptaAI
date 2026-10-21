import { useState } from 'react'
import { NavLink } from 'react-router'
import { Menu, X } from 'lucide-react'
import { CalendarIcon } from './icons'
import './Marketing.css'

export default function Navbar({ onBook }: { onBook: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <header className="nav navMinimal">
      <div className="container navMinimalInner">
        <a className="navBrand" href="/" aria-label="Recepta home">
          <img className="navLogo" src="/components/logoR.png" alt="Recepta" />
        </a>

        <button className="marketingMenuToggle" type="button" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="public-navigation" onClick={() => setOpen(!open)}>{open ? <X size={22} /> : <Menu size={22} />}</button>
        <div className={`marketingNavGroup ${open ? 'marketingNavGroupOpen' : ''}`} id="public-navigation">
        <nav className="marketingNavLinks" aria-label="Main navigation">
          <NavLink to="/our-product" onClick={() => setOpen(false)}>Our Product</NavLink>
          <NavLink to="/about" onClick={() => setOpen(false)}>About Us</NavLink>
          <NavLink to="/contact" onClick={() => setOpen(false)}>Contact Us</NavLink>
        </nav>
        <div className="navMinimalActions">
          <a className="btn btnGhost" href="/login">
            Customer Login
          </a>

          <button className="btn btnPrimary" type="button" onClick={() => { setOpen(false); onBook() }}>
            <CalendarIcon size={16} />
            Book a Demo
          </button>
        </div>
        </div>
      </div>
    </header>
  )
}
