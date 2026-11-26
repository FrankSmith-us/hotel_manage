import React, { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Building2,
  CalendarClock,
  CalendarOff,
  ChevronDown,
  CreditCard,
  FileSpreadsheet,
  Hotel,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Settings,
  Shield,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';

interface NavGroup {
  label: string;
  items: Array<{
    to: string;
    label: string;
    icon: React.ReactNode;
    roles?: string[];
  }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: '运营总览',
    items: [
      { to: '/', label: '运营工作台', icon: <LayoutDashboard className="w-4 h-4" /> },
      { to: '/organization', label: '门店与组织架构', icon: <Building2 className="w-4 h-4" /> },
    ],
  },
  {
    label: '报销与财务协同',
    items: [
      { to: '/reimbursements', label: '费用报销中心', icon: <Receipt className="w-4 h-4" /> },
      { to: '/advances', label: '备用金与借款', icon: <Wallet className="w-4 h-4" /> },
      {
        to: '/finance',
        label: '打款核销与预算报表',
        icon: <CreditCard className="w-4 h-4" />,
        roles: ['HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'],
      },
    ],
  },
  {
    label: 'HR 人力资源',
    items: [
      { to: '/employees', label: '员工档案与预警', icon: <Users className="w-4 h-4" /> },
      { to: '/schedules', label: '门店轮班排班', icon: <CalendarClock className="w-4 h-4" /> },
      { to: '/leaves', label: '请假与加班审批', icon: <CalendarOff className="w-4 h-4" /> },
      { to: '/payroll', label: '月度薪资台账', icon: <FileSpreadsheet className="w-4 h-4" /> },
      { to: '/recruitment', label: '补编与招聘入职', icon: <UserPlus className="w-4 h-4" /> },
    ],
  },
  {
    label: '系统管理',
    items: [
      {
        to: '/users',
        label: '账号与权限管理',
        icon: <Shield className="w-4 h-4" />,
        roles: ['HQ_ADMIN', 'HR_MANAGER'],
      },
      {
        to: '/system-config',
        label: '系统配置与基础数据',
        icon: <Settings className="w-4 h-4" />,
        roles: ['HQ_ADMIN'],
      },
    ],
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, demoAccounts, demoSwitchEnabled, switchDemoAccount, logout } = useAuth();
  const { showToast } = useToast();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherQuery, setSwitcherQuery] = useState('');
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [alertCounts, setAlertCounts] = useState({
    pendingExpenseCount: 0,
    urgentExpenseCount: 0,
    pendingOtherCount: 0,
    urgentOtherCount: 0,
  });
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    apiFetch<{
      kpis: {
        pendingExpenseCount: number;
        urgentExpenseCount: number;
        pendingOtherCount: number;
        urgentOtherCount: number;
      };
    }>('/api/dashboard/summary')
      .then((d) => setAlertCounts(d.kpis))
      .catch(() => {});
  }, [user?.id, location.pathname]);

  useEffect(() => {
    if (user?.must_change_password && !demoSwitchEnabled) {
      setPwOpen(true);
    }
  }, [user?.id, user?.must_change_password, demoSwitchEnabled]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPw !== confirmPw) {
      showToast('两次输入的新密码不一致', 'error');
      return;
    }
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ old_password: oldPw, new_password: newPw }),
      });
      showToast('密码已更新，请牢记新密码');
      setPwOpen(false);
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '修改密码失败', 'error');
    }
  };

  const handleSwitch = async (username: string) => {
    await switchDemoAccount(username);
    setSwitcherOpen(false);
    navigate('/');
  };

  return (
    <div className="min-h-screen flex bg-[#F8F7F4] text-stone-900">
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 bg-[#1C1917] text-stone-200 flex flex-col transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-5 border-b border-stone-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white shadow">
              <Hotel className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-white tracking-wide text-base">悦栖运营</div>
              <div className="text-[11px] text-stone-400">连锁酒店 HR & 报销平台</div>
            </div>
          </div>
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden text-stone-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter((item) => !item.roles || item.roles.includes(user?.role || ''));
            if (visibleItems.length === 0) return null;
            return (
              <div key={group.label}>
                <div className="px-3 mb-2 text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  {group.label}
                </div>
                <div className="space-y-1">
                  {visibleItems.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={() => setMobileOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-brand-600/20 text-brand-300 border border-brand-500/30'
                          : 'text-stone-300 hover:bg-stone-800/80 hover:text-white'
                      }`
                    }
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </NavLink>
                ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-stone-800">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-white truncate">{user?.display_name}</div>
              <div className="text-xs text-stone-400 truncate">
                {user?.role_label} · {user?.hotel_name || user?.region_name || '集团'}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPwOpen(true)}
                title="修改密码"
                className="p-2 rounded-lg text-stone-400 hover:text-amber-300 hover:bg-stone-800 transition-colors"
              >
                <KeyRound className="w-4 h-4" />
              </button>
              <button
                onClick={logout}
                title="退出登录"
                className="p-2 rounded-lg text-stone-400 hover:text-rose-300 hover:bg-stone-800 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-16 bg-white/90 backdrop-blur border-b border-stone-200/80 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-stone-200 text-stone-600"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="hidden sm:flex items-center gap-2 text-xs text-stone-500">
              <span className="px-2.5 py-1 rounded-full bg-brand-50 text-brand-800 font-medium border border-brand-200/70">
                {user?.hotel_name || '悦栖酒店集团'}
              </span>
              <span>当前身份：{user?.role_label}</span>
              {alertCounts.pendingExpenseCount > 0 && (
                <button
                  onClick={() => navigate('/reimbursements')}
                  className={`px-2.5 py-1 rounded-full border font-semibold transition-colors ${
                    alertCounts.urgentExpenseCount > 0
                      ? 'bg-red-50 border-red-200 text-red-600'
                      : 'bg-amber-50 border-amber-200 text-amber-800'
                  }`}
                >
                  费用审批 {alertCounts.pendingExpenseCount}
                  {alertCounts.urgentExpenseCount > 0 ? `（${alertCounts.urgentExpenseCount}紧急）` : ''}
                </button>
              )}
              {alertCounts.pendingOtherCount > 0 && (
                <button
                  onClick={() => navigate('/leaves')}
                  className={`px-2.5 py-1 rounded-full border font-semibold transition-colors ${
                    alertCounts.urgentOtherCount > 0
                      ? 'bg-red-50 border-red-200 text-red-600'
                      : 'bg-stone-100 border-stone-200 text-stone-700'
                  }`}
                >
                  其他审批 {alertCounts.pendingOtherCount}
                  {alertCounts.urgentOtherCount > 0 ? `（${alertCounts.urgentOtherCount}紧急）` : ''}
                </button>
              )}
            </div>
          </div>

          {demoSwitchEnabled && demoAccounts.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setSwitcherOpen((v) => !v)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl border border-brand-300 bg-brand-50/80 hover:bg-brand-100/80 text-xs font-medium text-brand-900 transition-colors"
              >
                <span>切换演示角色：{user?.display_name}（{user?.role_label}）</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {switcherOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setSwitcherOpen(false)}
                  />
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-2xl shadow-xl border border-stone-200 py-2 z-50">
                    <div className="px-4 py-2 text-[11px] font-semibold text-stone-400 uppercase border-b border-stone-100">
                      一键切换演示账号（共 {demoAccounts.length} 个）
                    </div>
                    <div className="px-3 py-2 border-b border-stone-100">
                      <input
                        type="text"
                        value={switcherQuery}
                        onChange={(e) => setSwitcherQuery(e.target.value)}
                        placeholder="按姓名 / 门店 / 角色筛选..."
                        className="w-full px-2.5 py-1.5 rounded-lg border border-stone-200 text-xs focus:outline-none focus:border-brand-500"
                      />
                    </div>
                    <div className="max-h-80 overflow-y-auto py-1">
                      {demoAccounts
                        .filter((acc) => {
                          const q = switcherQuery.trim().toLowerCase();
                          if (!q) return true;
                          return [
                            acc.display_name,
                            acc.username,
                            acc.role_label,
                            acc.position || '',
                            acc.hotel_name || '',
                            acc.region_name || '',
                          ].some((v) => v.toLowerCase().includes(q));
                        })
                        .map((acc) => (
                        <button
                          key={acc.username}
                          onClick={() => handleSwitch(acc.username)}
                          className={`w-full text-left px-4 py-2.5 text-xs hover:bg-stone-50 flex items-center justify-between ${
                            acc.username === user?.username ? 'bg-brand-50/70' : ''
                          }`}
                        >
                          <div className="min-w-0 pr-2">
                            <div className="font-semibold text-stone-900 truncate">
                              {acc.display_name}{' '}
                              <span className="text-brand-700 font-normal">({acc.role_label})</span>
                            </div>
                            <div className="text-stone-500 mt-0.5 truncate">
                              {acc.hotel_name || acc.region_name || '集团总部'}
                              {acc.position ? ` · ${acc.position}` : ''} · @{acc.username}
                            </div>
                          </div>
                          {acc.username === user?.username && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand-600 text-white shrink-0">
                              当前
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </header>

        <main className="flex-1 p-4 lg:p-8 max-w-[1440px] w-full mx-auto">{children}</main>
      </div>

      <Modal open={pwOpen} onClose={() => setPwOpen(false)} title="修改登录密码">
        <form onSubmit={handleChangePassword} className="space-y-4">
          {user?.must_change_password && !demoSwitchEnabled && (
            <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
              当前账号为初始或重置密码，请修改后再继续使用系统功能。
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">原密码 *</label>
            <input
              type="password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">新密码（至少8位，含字母和数字）*</label>
            <input
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">确认新密码 *</label>
            <input
              type="password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPwOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认修改
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
