import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/format';

interface DashboardSummary {
  yearMonth: string;
  kpis: {
    pendingApprovalsCount: number;
    monthlyExpense: number;
    monthlyBudget: number;
    budgetExecutionPct: number;
    activeHeadcount: number;
    complianceAlertsCount: number;
  };
  inbox: Array<{
    biz_type: string;
    biz_id: number;
    code: string;
    title: string;
    hotel_name: string;
    applicant_name: string;
    amount: number | null;
    step_name: string;
    risk_flags: string;
    created_at: string;
  }>;
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
};

const BIZ_LABEL: Record<string, string> = {
  REIMBURSEMENT: '费用报销',
  CASH_ADVANCE: '备用金借款',
  LEAVE: '请假/加班',
  HEADCOUNT: '门店补编',
};

export function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    apiFetch<DashboardSummary>('/api/dashboard/summary')
      .then(setData)
      .finally(() => setLoading(false));
  }, [user?.id]);

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
          title="待我审批事项"
          value={data.kpis.pendingApprovalsCount}
          subtitle="涵盖报销、备用金、请假、补编"
          icon={<CheckSquare className="w-5 h-5" />}
          accent="amber"
          onClick={() => navigate('/reimbursements')}
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
          title="在职/试用期员工"
          value={`${data.kpis.activeHeadcount} 人`}
          subtitle="当前权限范围内门店人数"
          icon={<Users className="w-5 h-5" />}
          accent="stone"
          onClick={() => navigate('/employees')}
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

      {/* Action Inbox + Compliance Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900">待我审批收件箱</h2>
              <p className="text-xs text-stone-500">点击任意待办可直接前往对应流程处理</p>
            </div>
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
              {data.inbox.length} 条待办
            </span>
          </div>

          {data.inbox.length === 0 ? (
            <div className="py-12 text-center text-sm text-stone-400">
              当前角色暂无待审批事项，切换其他演示角色可体验多级审批流
            </div>
          ) : (
            <div className="divide-y divide-stone-100">
              {data.inbox.map((item) => (
                <div
                  key={`${item.biz_type}-${item.biz_id}`}
                  onClick={() => navigate(BIZ_ROUTE[item.biz_type] || '/')}
                  className="py-3.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-stone-50/80 px-2 -mx-2 rounded-xl transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-brand-50 text-brand-800 border border-brand-200/60">
                        {BIZ_LABEL[item.biz_type] || item.biz_type}
                      </span>
                      <span className="font-medium text-sm text-stone-900 truncate">{item.title}</span>
                      {item.risk_flags && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 text-[11px] font-medium border border-rose-200">
                          <AlertTriangle className="w-3 h-3" />
                          风控预警
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      {item.code} · {item.hotel_name} · 申请人：{item.applicant_name} · 当前节点：{item.step_name}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {item.amount !== null && (
                      <span className="font-semibold text-sm text-stone-900 tabular-nums">
                        {formatMoney(item.amount)}
                      </span>
                    )}
                    <ArrowRight className="w-4 h-4 text-stone-400" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* HR Compliance Alerts */}
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
      </div>

      {/* Expense Trend Chart */}
      <div className="bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm">
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
  );
}
