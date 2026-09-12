import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import './index.css'

import App from './App.tsx'
import Login from './pages/Login.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Calls from './pages/Calls.tsx'
import CalendarPage from './pages/EmployeeCalendar.tsx'
import Agent from './pages/Agent.tsx'
import Billing from './pages/Billing.tsx'
import Settings from './pages/Settings.tsx'
import ResetPassword from './pages/ResetPassword.tsx'
import Admin from './pages/Admin.tsx'
import AdminClient from './pages/AdminClient.tsx'

import ProtectedRoute from './components/ProtectedRoute.tsx'
import AdminRoute from './components/AdminRoute.tsx'
import ActiveSubscriptionRoute from './components/ActiveSubscriptionRoute.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<App />} />

        <Route
          path="/login"
          element={<Login />}
        />

        <Route
          path="/reset-password"
          element={<ResetPassword />}
        />

        {/* =====================================================
            CLIENT DASHBOARD
           ===================================================== */}

        {/* Pending / Active / Cancelled users can reach Overview.
            Dashboard.tsx decides whether to show the real
            dashboard or the locked state. */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        {/* ACTIVE STANDARD + ACTIVE PRO */}
        <Route
          path="/dashboard/calls"
          element={
            <ProtectedRoute>
              <ActiveSubscriptionRoute>
                <Calls />
              </ActiveSubscriptionRoute>
            </ProtectedRoute>
          }
        />

        {/* ACTIVE STANDARD + ACTIVE PRO */}
        <Route
          path="/dashboard/calendar"
          element={
            <ProtectedRoute>
              <ActiveSubscriptionRoute>
                <CalendarPage />
              </ActiveSubscriptionRoute>
            </ProtectedRoute>
          }
        />

        {/* Legacy links now open the single calendar workspace. */}
        <Route
          path="/dashboard/appointments"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calendar" replace />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/employees"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calendar" replace />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/employee-hours"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calendar" replace />
            </ProtectedRoute>
          }
        />

        {/* ACTIVE STANDARD + ACTIVE PRO */}
        <Route
          path="/dashboard/agent"
          element={
            <ProtectedRoute>
              <ActiveSubscriptionRoute>
                <Agent />
              </ActiveSubscriptionRoute>
            </ProtectedRoute>
          }
        />

        {/* Billing stays reachable for logged-in users.
            This is important for cancelled customers later. */}
        <Route
          path="/dashboard/billing"
          element={
            <ProtectedRoute>
              <Billing />
            </ProtectedRoute>
          }
        />

        {/* Settings stays reachable for pending,
            active and cancelled users. */}
        <Route
          path="/dashboard/settings"
          element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          }
        />

        {/* The retired customer-request page returns to Overview. */}
        <Route
          path="/dashboard/requests"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard" replace />
            </ProtectedRoute>
          }
        />

        {/* =====================================================
            RECEPTA ADMIN
           ===================================================== */}

        <Route
          path="/admin"
          element={
            <AdminRoute>
              <Admin />
            </AdminRoute>
          }
        />

        <Route
          path="/admin/client/:id"
          element={
            <AdminRoute>
              <AdminClient />
            </AdminRoute>
          }
        />

        <Route
          path="/admin/requests"
          element={
            <AdminRoute>
              <Navigate to="/admin" replace />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
