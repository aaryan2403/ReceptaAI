import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router'
import './index.css'

import App from './App.tsx'
import Login from './pages/Login.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Calls from './pages/Calls.tsx'
import Appointments from './pages/Appointments.tsx'
import Agent from './pages/Agent.tsx'
import Billing from './pages/Billing.tsx'
import Settings from './pages/Settings.tsx'
import ResetPassword from './pages/ResetPassword.tsx'
import ProtectedRoute from './components/ProtectedRoute.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/login" element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/calls"
          element={
            <ProtectedRoute>
              <Calls />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/appointments"
          element={
            <ProtectedRoute>
              <Appointments />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/agent"
          element={
            <ProtectedRoute>
              <Agent />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/billing"
          element={
            <ProtectedRoute>
              <Billing />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/settings"
          element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
