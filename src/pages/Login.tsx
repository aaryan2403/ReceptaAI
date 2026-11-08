import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

export default function Login() {
  const navigate = useNavigate()

  const [signup, setSignup] = useState(false)
  const [company, setCompany] = useState('')
  const [plan, setPlan] = useState('Recepta Standard')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const handleLogin = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')

    const normalizedEmail =
      email.trim().toLowerCase()

    if (
      normalizedEmail ===
      ADMIN_EMAIL.toLowerCase()
    ) {
      setErrorMessage(
        'Admin accounts must sign in through the admin portal.'
      )
      setLoading(false)
      return
    }

    if (signup) {
      try {
        const { error } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/login`,
            data: { recepta_self_service: true, company_name: company.trim(), requested_plan: plan },
          },
        })
        if (error) throw new Error(error.message)
        setSignup(false)
        setPassword('')
        setSuccessMessage('Check your email for a confirmation link. Once confirmed, return here and sign in.')
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Could not create your account.')
      } finally {
        setLoading(false)
      }
      return
    }

    const { data, error } =
      await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

    if (error || !data.user) {
      setErrorMessage(
        'Invalid email or password.'
      )
      setLoading(false)
      return
    }

    if (
      data.user.email?.toLowerCase() ===
      ADMIN_EMAIL.toLowerCase()
    ) {
      await supabase.auth.signOut()

      setErrorMessage(
        'Admin accounts must sign in through the admin portal.'
      )
      setLoading(false)
      return
    }

    if (data.user.user_metadata.recepta_self_service === true) {
      try {
        const response = await fetch('/.netlify/functions/onboard-customer', {
          method: 'POST', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        })
        if (!response.ok) {
          const result = await response.json().catch(() => ({}))
          throw new Error(result.error || 'Could not finish setting up your account.')
        }
        navigate('/dashboard/billing')
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Could not finish setting up your account.')
        setLoading(false)
      }
      return
    }
    navigate('/dashboard')
  }

  const handleForgotPassword = async () => {
    setErrorMessage('')
    setSuccessMessage('')

    if (!email) {
      setErrorMessage('Enter your email first.')
      return
    }

    if (
      email.trim().toLowerCase() ===
      ADMIN_EMAIL.toLowerCase()
    ) {
      setErrorMessage(
        'Admin password management must be done through the admin account.'
      )
      return
    }

    setLoading(true)

    const { error } =
      await supabase.auth.resetPasswordForEmail(
        email.trim(),
        {
          redirectTo: `${window.location.origin}/reset-password`,
        }
      )

    if (error) {
      setErrorMessage(
        'Could not send password reset email.'
      )
      setLoading(false)
      return
    }

    setSuccessMessage(
      'Password reset email sent.'
    )
    setLoading(false)
  }

  return (
    <main className="loginPage">
      <div className="loginGlow" />

      <div className="loginCard">
        <a
          href="/"
          className="loginBrand"
        >
          <img
            src="/components/logoR.png"
            alt="Recepta"
            className="loginLogo"
          />
        </a>

        <div className="loginHeading">
          <h1>{signup ? 'Create your Recepta account' : 'Customer Login'}</h1>

          <p>
            Sign in to manage your Recepta AI
            receptionist.
          </p>
        </div>

        <form
          className="loginForm"
          onSubmit={handleLogin}
        >
          {signup && <>
            <label>Business name<input required minLength={2} maxLength={120} value={company} onChange={event => setCompany(event.target.value)} /></label>
            <label>Plan<select value={plan} onChange={event => setPlan(event.target.value)}>
              <option value="Recepta Standard">Standard · C$199 base per month</option>
              <option value="Recepta Pro">Pro · C$299 base per month</option>
            </select></label>
            <p>Call minutes and optional numbers are priced in Billing before payment.</p>
          </>}
          <label>
            Email

            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              required
            />
          </label>

          <label>
            Password

            <input
              type="password"
              minLength={signup ? 8 : undefined}
              placeholder="Enter your password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              required
            />
          </label>

          {!signup && <div className="loginOptions">
            <span />

            <button
              type="button"
              className="forgotPassword"
              onClick={handleForgotPassword}
              disabled={loading}
            >
              Forgot password?
            </button>
          </div>}

          {errorMessage && (
            <p className="loginError">
              {errorMessage}
            </p>
          )}

          {successMessage && (
            <p className="loginSuccess">
              {successMessage}
            </p>
          )}

          <button
            className="btn btnPrimary loginButton"
            type="submit"
            disabled={loading}
          >
            {loading
              ? 'Please wait...'
              : signup ? 'Create account' : 'Customer Login'}
          </button>
        </form>

        <p className="loginHelp">
          <button type="button" className="forgotPassword" disabled={loading} onClick={() => {
            setSignup(!signup); setErrorMessage(''); setSuccessMessage('')
          }}>{signup ? 'Back to customer login' : 'Create a customer account'}</button>
        </p>
      </div>
    </main>
  )
}
