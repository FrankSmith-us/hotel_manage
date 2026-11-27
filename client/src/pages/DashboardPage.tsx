import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckSquare,
  Receipt,
  ShieldAlert,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { KpiCard } from '../components/KpiCard';
import { StatusBadge } from '../components/StatusBadge';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ACTION_LABEL_MAP, formatMoney } from '../lib/format';

interface InboxItem {
  biz_type: string;
  biz_id: number;
  code: string;
  title: string;
  hotel_name: string;
  applicant_name: string;
  amount: number | null;
  step_name: string;
  risk_flags: string;
  urgency: 'NORMAL' | 'URGENT';
  created_at: string;
}

interface TrackedWorkflowItem {
  biz_type: string;
  biz_id: number;
  code: string;
  title: string;
  hotel_name: string;
  applicant_name: string;
  amount: number | null;
  status: string;
  status_detail: string;
  urgency: 'NORMAL' | 'URGENT';
  my_action?: string | null;
  my_acted_at?: string | null;
  created_at: string;
  updated_at: string;
}

interface DashboardSummary {
  yearMonth: string;
  kpis: {
    pendingApprovalsCount: number;
    pendingExpenseCount: number;
    urgentExpenseCount: number;
    pendingOtherCount: number;
    urgentOtherCount: number;
    monthlyExpense: number;
    monthlyBudget: number;
    budgetExecutionPct: number;
    activeHeadcount: number;
    complianceAlertsCount: number;
    myApplicationsCount: number;
    myHandledCount: number;
  };
  expenseInbox: InboxItem[];
  otherInbox: InboxItem[];
  inbox: InboxItem[];
  myApplications: TrackedWorkflowItem[];
  myHandledApprovals: TrackedWorkflowItem[];
  complianceAlerts: Array<{
    id: number;
    emp_no: string;
    name: string;
    position: string;
    hotel_name: string;
    health_cert_expiry: string | null;
    contract_end_date: string | null;
  }>;
  expenseTrend: Array<{ month: string; paid: number; pending: number }>;
  hotelBreakdown: Array<{ hotel_name: string; total_amount: number }>;
}

const BIZ_ROUTE: Record<string, string> = {
  REIMBURSEMENT: '/reimbursements',
  CASH_ADVANCE: '/advances',
  LEAVE: '/leaves',
  HEADCOUNT: '/recruitment',
  HOTEL_CLOSURE: '/organization',
  OFFBOARDING: '/employees?tab=offboarding&filter=pending',
  ONBOARDING: '/employees?tab=onboarding&filter=pending',
  EMPLOYEE_CHANGE: '/employees',
  CONTRACT_RENEWAL: '/employees',
  OVERTIME: '/leaves',
  ATTENDANCE_CORRECTION: '/schedules',
  SHIFT_SWAP: '/schedules',
  PAYROLL_BATCH: '/payroll',
  VENDOR_PAYMENT: '/finance',
};

const BIZ_LABEL: Record<string, string> = {
  REIMBURSEMENT: '费用报销',
  CASH_ADVANCE: '备用金借款',
  LEAVE: '请假/加班',
  HEADCOUNT: '门店补编',
  HOTEL_CLOSURE: '门店关闭审批',
  OFFBOARDING: '员工离职',
  ONBOARDING: '员工入职',
  EMPLOYEE_CHANGE: '人事异动',
  CONTRACT_RENEWAL: '合同续签',
  OVERTIME: '加班申请',
  ATTENDANCE_CORRECTION: '考勤补卡',
  SHIFT_SWAP: '换班申请',
  PAYROLL_BATCH: '薪资批次',
  VENDOR_PAYMENT: '对公付款',
};

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [trackTab, setTrackTab] = useState<'mine' | 'handled'>('mine');

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    setLoading(true);
    apiFetch<DashboardSummary>('/api/dashboard/summary')
      .then(setData)
      .finally(() => setLoading(false));
  }, [user?.id]);

  useEffect(() => {
    if (loading || !data) return;
    const focus = searchParams.get('focus');
    if (focus === 'other-inbox' || focus === 'expense-inbox') {
      scrollToSection(focus);
    }
  }, [loading, data, searchParams]);

  if (loading || !data) {
    return <div className="py-16 text-center text-sm text-stone-500">正在加载运营工作台数据...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">
            你好，{user?.display_name}（{user?.role_label}）
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            当前业务账期：{data.yearMonth} · 所属范围：{user?.hotel_name || user?.region_name || '全集团'}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => navigate('/reimbursements')}
            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium transition-colors flex items-center gap-2"
          >
            <Receipt className="w-4 h-4" />
            <span>发起/审批报销</span>
          </button>
          <button
            onClick={() => navigate('/schedules')}
            className="px-4 py-2 rounded-xl bg-white border border-stone-200 hover:border-brand-300 text-stone-700 text-sm font-medium transition-colors"
          >
            查看本周排班
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="待办费用审批"
          value={data.kpis.pendingExpenseCount}
          subtitle={
            data.kpis.urgentExpenseCount > 0 ? (
              <span className="text-red-600 font-semibold">
                含 {data.kpis.urgentExpenseCount} 项紧急费用审批
              </span>
            ) : (
              '费用报销 / 备用金借款（优先处理）'
            )
          }
          icon={<Receipt className="w-5 h-5" />}
          accent={data.kpis.urgentExpenseCount > 0 ? 'rose' : 'amber'}
          onClick={() => scrollToSection('expense-inbox')}
        />
        <KpiCard
          title="待办其他业务审批"
          value={data.kpis.pendingOtherCount}
          subtitle={
            data.kpis.urgentOtherCount > 0 ? (
              <span className="text-red-600 font-semibold">
                含 {data.kpis.urgentOtherCount} 项紧急人事/补编审批
              </span>
            ) : (
              '请假加班 / 入离职 / 门店补编与关店审批'
            )
          }
          icon={<CheckSquare className="w-5 h-5" />}
          accent={data.kpis.urgentOtherCount > 0 ? 'rose' : 'stone'}
          onClick={() => scrollToSection('other-inbox')}
        />
        <KpiCard
          title="本月累计报销金额"
          value={formatMoney(data.kpis.monthlyExpense)}
          subtitle={`预算执行率 ${data.kpis.budgetExecutionPct}%（预算 ${formatMoney(data.kpis.monthlyBudget)}）`}
          icon={<Wallet className="w-5 h-5" />}
          accent="emerald"
          onClick={() => navigate('/finance')}
        />
        <KpiCard
          title="证照与合同到期预警"
          value={`${data.kpis.complianceAlertsCount} 项`}
          subtitle="健康证或劳动合同 30 天内到期"
          icon={<ShieldAlert className="w-5 h-5" />}
          accent={data.kpis.complianceAlertsCount > 0 ? 'rose' : 'emerald'}
          onClick={() => navigate('/employees')}
        />
      </div>

      {/* Separated Approval Reminders: Expense Approvals FIRST, then Other Business Approvals */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div id="expense-inbox" className="lg:col-span-6 bg-white rounded-2xl border-2 border-brand-200/80 p-5 shadow-sm scroll-mt-20">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900 flex items-center gap-2">
                <Receipt className="w-4 h-4 text-brand-600" />
                <span>费用审批提醒（优先处理）</span>
              </h2>
              <p className="text-xs text-stone-500">费用报销、退回重提与备用金借款审批</p>
            </div>
            <div className="flex items-center gap-1.5">
              {data.kpis.urgentExpenseCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-50 text-red-600 border border-red-200">
                  {data.kpis.urgentExpenseCount} 紧急
                </span>
              )}
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                {data.expenseInbox.length} 条待办
              </span>
            </div>
          </div>

          {data.expenseInbox.length === 0 ? (
            <div className="py-10 text-center text-sm text-stone-400">暂无待处理费用审批</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {data.expenseInbox.map((item) => {
                const isUrgent = item.urgency === 'URGENT';
                return (
                  <div
                    key={`${item.biz_type}-${item.biz_id}`}
                    onClick={() => navigate(BIZ_ROUTE[item.biz_type] || '/')}
                    className={`py-3.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-stone-50/80 px-2 -mx-2 rounded-xl transition-colors ${
                      isUrgent ? 'bg-red-50/40' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-brand-50 text-brand-800 border border-brand-200/60">
                          {BIZ_LABEL[item.biz_type] || item.biz_type}
                        </span>
                        {isUrgent && (
                          <span className="text-xs font-bold text-red-600 shrink-0">【紧急】</span>
                        )}
                        <span
                          className={`font-medium text-sm truncate ${
                            isUrgent ? 'text-red-600 font-semibold' : 'text-stone-900'
                          }`}
                        >
                          {item.title}
                        </span>
                        {item.risk_flags && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 text-[11px] font-medium border border-rose-200">
                            <AlertTriangle className="w-3 h-3" />
                            风控预警
                          </span>
                        )}
                      </div>
                      <div className={`text-xs mt-1 ${isUrgent ? 'text-red-600' : 'text-stone-500'}`}>
                        {item.code} · {item.hotel_name} · 申请人：{item.applicant_name} · 当前节点：{item.step_name}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {item.amount !== null && (
                        <span
                          className={`font-semibold text-sm tabular-nums ${
                            isUrgent ? 'text-red-600' : 'text-stone-900'
                          }`}
                        >
                          {formatMoney(item.amount)}
                        </span>
                      )}
                      <ArrowRight className={`w-4 h-4 ${isUrgent ? 'text-red-500' : 'text-stone-400'}`} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div id="other-inbox" className="lg:col-span-6 bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm scroll-mt-20">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900 flex items-center gap-2">
                <Users className="w-4 h-4 text-stone-600" />
                <span>其他业务审批提醒</span>
              </h2>
              <p className="text-xs text-stone-500">请假加班、入离职、人事异动、门店补编与关店审批</p>
            </div>
            <div className="flex items-center gap-1.5">
              {data.kpis.urgentOtherCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-50 text-red-600 border border-red-200">
                  {data.kpis.urgentOtherCount} 紧急
                </span>
              )}
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-stone-100 text-stone-700 border border-stone-200">
                {data.otherInbox.length} 条待办
              </span>
            </div>
          </div>

          {data.otherInbox.length === 0 ? (
            <div className="py-10 text-center text-sm text-stone-400">暂无待处理其他业务审批</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {data.otherInbox.map((item) => {
                const isUrgent = item.urgency === 'URGENT';
                return (
                  <div
                    key={`${item.biz_type}-${item.biz_id}`}
                    onClick={() => navigate(BIZ_ROUTE[item.biz_type] || '/')}
                    className={`py-3.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-stone-50/80 px-2 -mx-2 rounded-xl transition-colors ${
                      isUrgent ? 'bg-red-50/40' : ''
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-stone-100 text-stone-700 border border-stone-200">
                          {BIZ_LABEL[item.biz_type] || item.biz_type}
                        </span>
                        {isUrgent && (
                          <span className="text-xs font-bold text-red-600 shrink-0">【紧急】</span>
                        )}
                        <span
                          className={`font-medium text-sm truncate ${
                            isUrgent ? 'text-red-600 font-semibold' : 'text-stone-900'
                          }`}
                        >
                          {item.title}
                        </span>
                      </div>
                      <div className={`text-xs mt-1 ${isUrgent ? 'text-red-600' : 'text-stone-500'}`}>
                        {item.code} · {item.hotel_name} · 申请人：{item.applicant_name} · 当前节点：{item.step_name}
                      </div>
                    </div>
                    <ArrowRight className={`w-4 h-4 shrink-0 ${isUrgent ? 'text-red-500' : 'text-stone-400'}`} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* My Applications & Handled Approvals Live Status Tracker */}
      <div className="bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">我的申请与审批进度追踪</h2>
            <p className="text-xs text-stone-500">
              实时查看本人提交的各类申请单，以及本人曾参与审批/付款单据的最新流转状态
            </p>
          </div>
          <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl w-fit">
            <button
              onClick={() => setTrackTab('mine')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                trackTab === 'mine' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
              }`}
            >
              我申请的单据 ({data.myApplications.length})
            </button>
            <button
              onClick={() => setTrackTab('handled')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                trackTab === 'handled' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
              }`}
            >
              我审批过的单据 ({data.myHandledApprovals.length})
            </button>
          </div>
        </div>

        {(trackTab === 'mine' ? data.myApplications : data.myHandledApprovals).length === 0 ? (
          <div className="py-8 text-center text-sm text-stone-400">
            {trackTab === 'mine' ? '暂无由您本人提交的申请单' : '暂无由您审批或处理的单据'}
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {(trackTab === 'mine' ? data.myApplications : data.myHandledApprovals).map((item) => {
              const isUrgent = item.urgency === 'URGENT';
              const targetUrl =
                item.biz_type === 'REIMBURSEMENT'
                  ? `/reimbursements?tab=${trackTab}&openId=${item.biz_id}`
                  : `${BIZ_ROUTE[item.biz_type] || '/'}?tab=${trackTab}`;
              return (
                <div
                  key={`${trackTab}-${item.biz_type}-${item.biz_id}`}
                  onClick={() => navigate(targetUrl)}
                  className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 cursor-pointer hover:bg-stone-50/80 px-2 -mx-2 rounded-xl transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-stone-100 text-stone-700 border border-stone-200">
                        {BIZ_LABEL[item.biz_type] || item.biz_type}
                      </span>
                      {isUrgent && (
                        <span className="text-xs font-bold text-red-600">【紧急】</span>
                      )}
                      <span
                        className={`font-medium text-sm truncate ${
                          isUrgent ? 'text-red-600 font-semibold' : 'text-stone-900'
                        }`}
                      >
                        {item.title}
                      </span>
                      {trackTab === 'handled' && item.my_action && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                          {ACTION_LABEL_MAP[item.my_action] || item.my_action}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      {item.code} · {item.hotel_name}
                      {trackTab === 'handled' ? ` · 申请人：${item.applicant_name}` : ''} · 当前进度：{item.status_detail}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {item.amount !== null && (
                      <span className="font-semibold text-sm tabular-nums text-stone-900">
                        {formatMoney(item.amount)}
                      </span>
                    )}
                    <StatusBadge status={item.status} />
                    <ArrowRight className="w-4 h-4 text-stone-400" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* HR Compliance Alerts + Expense Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900">HR 合规到期预警</h2>
              <p className="text-xs text-stone-500">酒店健康证与劳动合同 30 天内到期清单</p>
            </div>
            <button
              onClick={() => navigate('/employees')}
              className="text-xs font-medium text-brand-700 hover:text-brand-800"
            >
              查看全部 →
            </button>
          </div>

          {data.complianceAlerts.length === 0 ? (
            <div className="py-12 text-center text-sm text-stone-400">证照与合同状态均正常</div>
          ) : (
            <div className="space-y-2.5">
              {data.complianceAlerts.map((emp) => (
                <div
                  key={emp.id}
                  onClick={() => navigate('/employees')}
                  className="p-3 rounded-xl border border-rose-100 bg-rose-50/40 hover:bg-rose-50/80 cursor-pointer transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-stone-900">
                      {emp.name} <span className="text-xs font-normal text-stone-500">({emp.position})</span>
                    </span>
                    <span className="text-xs text-stone-500">{emp.hotel_name}</span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
                    {emp.health_cert_expiry && (
                      <span className="text-rose-700 font-medium">
                        健康证到期：{emp.health_cert_expiry}
                      </span>
                    )}
                    {emp.contract_end_date && (
                      <span className="text-amber-700 font-medium">
                        合同到期：{emp.contract_end_date}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-7 bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">近 6 个月门店报销支出趋势</h2>
            <p className="text-xs text-stone-500">区分已打款核销与审批/待打款金额（单位：元）</p>
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.expenseTrend} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E7E5E4" />
              <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#78716C' }} />
              <YAxis tick={{ fontSize: 12, fill: '#78716C' }} />
              <Tooltip
                formatter={(v: number) => formatMoney(v)}
                contentStyle={{ borderRadius: '12px', borderColor: '#E7E5E4' }}
              />
              <Legend />
              <Bar dataKey="paid" name="已打款核销" stackId="a" fill="#B47B38" radius={[0, 0, 4, 4]} />
              <Bar dataKey="pending" name="审批/待打款" stackId="a" fill="#E7B68E" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      </div>
    </div>
  );
}
