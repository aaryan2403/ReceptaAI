import { CalendarIcon } from './icons'

export default function Navbar({ onBook }: { onBook: () => void }) {
  return (
    <header className="nav navMinimal">
      <div className="container navMinimalInner">
        <a className="navBrand" href="#top" aria-label="Recepta home">
          <img className="navLogo" src="/components/logoR.png" alt="Recepta" />
        </a>

        <div className="navMinimalActions">
          <a className="btn btnGhost" href="/login">
            Customer Login
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
