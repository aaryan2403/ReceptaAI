import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

const ADMIN_EMAIL = 'aaryansmg24@gmail.com'

export default function Login() {
  const navigate = useNavigate()

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
          <h1>Customer Login</h1>

          <p>
            Sign in to manage your Recepta AI
            receptionist.
          </p>
        </div>

        <form
          className="loginForm"
          onSubmit={handleLogin}
        >
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
              placeholder="Enter your password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              required
            />
          </label>

          <div className="loginOptions">
            <span />

            <button
              type="button"
              className="forgotPassword"
              onClick={handleForgotPassword}
              disabled={loading}
            >
              Forgot password?
            </button>
          </div>

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
              : 'Customer Login'}
          </button>
        </form>

        <p className="loginHelp">
          Don't have an account? Recepta
          accounts are created for active
          clients.
        </p>
      </div>
    </main>
  )
}
