import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { AuthProvider, useAuth } from './lib/auth';
import { AdvancesPage } from './pages/AdvancesPage';
import { DashboardPage } from './pages/DashboardPage';
import { EmployeesPage } from './pages/EmployeesPage';
import { FinancePayoutPage } from './pages/FinancePayoutPage';
import { LeavesPage } from './pages/LeavesPage';
import { LoginPage } from './pages/LoginPage';
import { OrganizationPage } from './pages/OrganizationPage';
import { PayrollPage } from './pages/PayrollPage';
import { RecruitmentPage } from './pages/RecruitmentPage';
import { ReimbursementsPage } from './pages/ReimbursementsPage';
import { SchedulesPage } from './pages/SchedulesPage';

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8F7F4] text-sm text-stone-500">
        正在初始化悦栖运营系统...
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/organization" element={<OrganizationPage />} />
        <Route path="/reimbursements" element={<ReimbursementsPage />} />
        <Route path="/advances" element={<AdvancesPage />} />
        <Route path="/finance" element={<FinancePayoutPage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />
        <Route path="/leaves" element={<LeavesPage />} />
        <Route path="/payroll" element={<PayrollPage />} />
        <Route path="/recruitment" element={<RecruitmentPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
