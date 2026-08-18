import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

export default function Login() {
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setLoading(true)
    setErrorMessage('')

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      setErrorMessage('Invalid email or password.')
      setLoading(false)
      return
    }

    navigate('/dashboard')
  }

  return (
    <main className="loginPage">
      <div className="loginGlow" />

      <div className="loginCard">
        <a href="/" className="loginBrand">
          <img
            src="/components/logoR.png"
            alt="Recepta"
            className="loginLogo"
          />
        </a>

        <div className="loginHeading">
          <h1>Welcome back</h1>
          <p>Sign in to manage your Recepta AI receptionist.</p>
        </div>

        <form className="loginForm" onSubmit={handleLogin}>
          <label>
            Email
            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <div className="loginOptions">
            <span />
            <button type="button" className="forgotPassword">
              Forgot password?
            </button>
          </div>

          {errorMessage && (
            <p className="loginError">
              {errorMessage}
            </p>
          )}

          <button
            className="btn btnPrimary loginButton"
            type="submit"
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Log in'}
          </button>
        </form>

        <p className="loginHelp">
          Don't have an account? Recepta accounts are created for active clients.
        </p>
      </div>
    </main>
  )
}
