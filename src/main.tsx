import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import './index.css'

import App from './App.tsx'
import Login from './pages/Login.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Calls from './pages/Calls.tsx'
import Appointments from './pages/Appointments.tsx'
import Employees from './pages/Employees.tsx'
import EmployeeHours from './pages/EmployeeHours.tsx'
import Agent from './pages/Agent.tsx'
import Billing from './pages/Billing.tsx'
import Settings from './pages/Settings.tsx'
import CustomerRequests from './pages/CustomerRequests.tsx'
import ResetPassword from './pages/ResetPassword.tsx'
import Admin from './pages/Admin.tsx'
import AdminClient from './pages/AdminClient.tsx'
import AdminRequests from './pages/AdminRequests.tsx'

import ProtectedRoute from './components/ProtectedRoute.tsx'
import AdminRoute from './components/AdminRoute.tsx'
import ProRoute from './components/ProRoute.tsx'
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

        {/* ACTIVE PRO ONLY */}
        <Route
          path="/dashboard/appointments"
          element={
            <ProtectedRoute>
              <ProRoute>
                <Appointments />
              </ProRoute>
            </ProtectedRoute>
          }
        />

        {/* ACTIVE STANDARD + ACTIVE PRO */}
        <Route
          path="/dashboard/employees"
          element={
            <ProtectedRoute>
              <ActiveSubscriptionRoute>
                <Employees />
              </ActiveSubscriptionRoute>
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/employee-hours"
          element={
            <ProtectedRoute>
              <ActiveSubscriptionRoute>
                <EmployeeHours />
              </ActiveSubscriptionRoute>
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

        {/* Customer support requests stay reachable for every
            logged-in Standard or Pro customer. */}
        <Route
          path="/dashboard/requests"
          element={
            <ProtectedRoute>
              <CustomerRequests />
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
              <AdminRequests />
            </AdminRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
