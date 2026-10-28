import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import './index.css'

import App from './App.tsx'
import Login from './pages/Login.tsx'
import Dashboard from './pages/Dashboard.tsx'
import Calls from './pages/Calls.tsx'
import Bookings from './pages/Bookings.tsx'
import Agent from './pages/Agent.tsx'
import Billing from './pages/Billing.tsx'
import Settings from './pages/Settings.tsx'
import ResetPassword from './pages/ResetPassword.tsx'
import Admin from './pages/Admin.tsx'
import AdminOperationsPage from './pages/AdminOperationsPage.tsx'
import CustomerRequests from './pages/CustomerRequests.tsx'
import AdminRequests from './pages/AdminRequests.tsx'
import Demo from './pages/Demo.tsx'
import Legal from './pages/Legal.tsx'
import OurProduct from './pages/OurProduct.tsx'
import Contact from './pages/Contact.tsx'
import About from './pages/About.tsx'

import ProtectedRoute from './components/ProtectedRoute.tsx'
import AdminRoute from './components/AdminRoute.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<App />} />
        <Route path="/our-product" element={<OurProduct />} />
        <Route path="/product" element={<Navigate to="/our-product" replace />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/about" element={<About />} />
        <Route path="/demo" element={<Demo />} />
        <Route path="/privacy" element={<Legal page="privacy" />} />
        <Route path="/terms" element={<Legal page="terms" />} />

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

        {/* Every signed-in customer can view the workspace.
            Billing controls receptionist service, not page access. */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />

        {/* Dashboard pages remain available after billing ends. */}
        <Route
          path="/dashboard/calls"
          element={
            <ProtectedRoute>
              <Calls />
            </ProtectedRoute>
          }
        />

        <Route path="/dashboard/bookings" element={<ProtectedRoute><Bookings /></ProtectedRoute>} />

        {/* Appointment details now live inside the Calls workspace. */}
        <Route
          path="/dashboard/appointments"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calls" replace />
            </ProtectedRoute>
          }
        />

        {/* Old calendar links now open the appointment records workspace. */}
        <Route
          path="/dashboard/calendar"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calls" replace />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/employees"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calls" replace />
            </ProtectedRoute>
          }
        />

        <Route
          path="/dashboard/employee-hours"
          element={
            <ProtectedRoute>
              <Navigate to="/dashboard/calls" replace />
            </ProtectedRoute>
          }
        />

        {/* Dashboard pages remain available after billing ends. */}
        <Route
          path="/dashboard/agent"
          element={
            <ProtectedRoute>
              <Agent />
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

        {/* Available to both Standard and Pro customers. */}
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
              <Navigate to="/admin" replace />
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

        <Route path="/admin/operations" element={<AdminRoute><AdminOperationsPage /></AdminRoute>} />

      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
