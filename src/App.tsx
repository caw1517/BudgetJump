import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from './layouts/AppLayout'
import { AccountsPage } from './pages/AccountsPage'
import { BudgetPage } from './pages/BudgetPage'
import { DashboardPage } from './pages/DashboardPage'
import { EnvelopesPage } from './pages/EnvelopesPage'
import { JournalPage } from './pages/JournalPage'
import { LoginPage } from './pages/LoginPage'
import { DebtPage } from './pages/DebtPage'
import { ReportsPage } from './pages/ReportsPage'
import { SettingsPage } from './pages/SettingsPage'
import { SavingsGoalsPage } from './pages/SavingsGoalsPage'
import { TransactionsPage } from './pages/TransactionsPage'
import { AuthBootstrap } from './routes/AuthBootstrap'
import { ProtectedRoute } from './routes/ProtectedRoute'

export default function App() {
  return (
    <BrowserRouter>
      <AuthBootstrap />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="journal" element={<JournalPage />} />
            <Route path="accounts" element={<AccountsPage />} />
            <Route path="envelopes" element={<EnvelopesPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="budget" element={<BudgetPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="savings" element={<SavingsGoalsPage />} />
            <Route path="debt" element={<DebtPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
