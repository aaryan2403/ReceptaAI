import { useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { supabase } from '../lib/supabase'

export default function ResetPassword() {
  const navigate = useNavigate()

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')

  const handleResetPassword = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault()

    setErrorMessage('')
    setSuccessMessage('')

    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.')
      return
    }

    if (password !== confirmPassword) {
      setErrorMessage('Passwords do not match.')
      return
    }

    setLoading(true)

    const { error } = await supabase.auth.updateUser({
      password,
    })

    if (error) {
      setErrorMessage('Could not update password.')
      setLoading(false)
      return
    }

    setSuccessMessage('Password updated successfully.')

    setTimeout(() => {
      navigate('/dashboard')
    }, 1200)
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
          <h1>Create a new password</h1>
          <p>
            Enter your new Recepta account password below.
          </p>
        </div>

        <form
          className="loginForm"
          onSubmit={handleResetPassword}
        >
          <label>
            New Password
            <input
              type="password"
              placeholder="Enter new password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              required
            />
          </label>

          <label>
            Confirm Password
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(event) =>
                setConfirmPassword(event.target.value)
              }
              required
            />
          </label>

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
              ? 'Updating password...'
              : 'Update Password'}
          </button>
        </form>
      </div>
    </main>
  )
}
