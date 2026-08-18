
export default function Login() {
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

        <form className="loginForm">
          <label>
            Email
            <input
              type="email"
              placeholder="you@company.com"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              placeholder="Enter your password"
              required
            />
          </label>

          <div className="loginOptions">
            <span />
            <button type="button" className="forgotPassword">
              Forgot password?
            </button>
          </div>

          <button className="btn btnPrimary loginButton" type="submit">
            Log in
          </button>
        </form>

        <p className="loginHelp">
          Don't have an account? Recepta accounts are created for active clients.
        </p>
      </div>
    </main>
  )
}
