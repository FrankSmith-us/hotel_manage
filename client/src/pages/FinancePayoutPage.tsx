import React, { useCallback, useEffect, useState } from 'react';
import { CreditCard, Download, Edit3 } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { currentYearMonth, formatMoney } from '../lib/format';

interface QueueRow {
  id: number;
  claim_no: string;
  title: string;
  hotel_name: string;
  applicant_name: string;
  expense_month: string;
  payment_type: 'CORPORATE' | 'PERSONAL';
  payee_name: string;
  payee_bank: string | null;
  payee_account: string | null;
  total_amount: number;
  offset_amount: number;
  net_pay_amount: number;
}

interface BudgetRow {
  hotel_id: number;
  hotel_name: string;
  year_month: string;
  category: string;
  category_label: string;
  budget_amount: number;
  paid_amount: number;
  pending_amount: number;
  used_amount: number;
  remaining_amount: number;
  utilization_pct: number;
  is_over_budget: boolean;
}

interface ReportData {
  yearMonth: string;
  byHotel: Array<{ hotel_name: string; paid_amount: number; pending_amount: number; total_amount: number }>;
  byCategory: Array<{ category_label: string; total_amount: number }>;
}

const PIE_COLORS = ['#B47B38', '#D97706', '#0D9488', '#4F46E5', '#E11D48', '#65A30D', '#78716C'];

export function FinancePayoutPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isFinance = ['HQ_ADMIN', 'FINANCE'].includes(user?.role || '');

  const [tab, setTab] = useState<'payout' | 'budgets' | 'reports'>(isFinance ? 'payout' : 'budgets');
  const [yearMonth, setYearMonth] = useState(currentYearMonth());

  // Payout Queue
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [channel, setChannel] = useState('BANK_TRANSFER');
  const [paymentRef, setPaymentRef] = useState('');

  // Budgets
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [editingBudget, setEditingBudget] = useState<BudgetRow | null>(null);
  const [budgetAmountInput, setBudgetAmountInput] = useState(0);

  // Reports
  const [report, setReport] = useState<ReportData | null>(null);

  const loadData = useCallback(async () => {
    if (tab === 'payout' && isFinance) {
      const d = await apiFetch<{ reimbursements: QueueRow[] }>('/api/reimbursements?tab=payout_queue');
      setQueue(d.reimbursements);
      setSelectedIds([]);
    } else if (tab === 'budgets') {
      const d = await apiFetch<{ budgets: BudgetRow[] }>(`/api/budgets?yearMonth=${yearMonth}`);
      setBudgets(d.budgets);
    } else if (tab === 'reports') {
      const d = await apiFetch<ReportData>(`/api/reports/expenses?yearMonth=${yearMonth}`);
      setReport(d);
    }
  }, [tab, yearMonth, isFinance]);

  useEffect(() => {
    loadData();
  }, [loadData, user?.id]);

  const handleBatchPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/reimbursements/payout', {
        method: 'POST',
        body: JSON.stringify({
          reimbursement_ids: selectedIds,
          payment_channel: channel,
          payment_ref: paymentRef,
        }),
      });
      showToast(`已成功核销打款 ${selectedIds.length} 笔报销单`);
      setPayoutOpen(false);
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '打款失败', 'error');
    }
  };

  const handleSaveBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBudget) return;
    try {
      await apiFetch('/api/budgets', {
        method: 'PUT',
        body: JSON.stringify({
          hotel_id: editingBudget.hotel_id,
          year_month: editingBudget.year_month,
          category: editingBudget.category,
          budget_amount: Number(budgetAmountInput),
        }),
      });
      showToast('门店月度预算已更新');
      setEditingBudget(null);
      await loadData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失败', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">财务打款核销与预算报表</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            财务批量打款核销（自动结算冲销借款）、门店分科目月度预算监控与费用看板
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {tab !== 'payout' && (
            <input
              type="month"
              value={yearMonth}
              onChange={(e) => setYearMonth(e.target.value)}
              className="px-3 py-2 rounded-xl border border-stone-200 bg-white text-sm"
            />
          )}
          <button
            onClick={() => downloadCsv(`/api/reports/expenses/export?yearMonth=${yearMonth}`, `expense-report-${yearMonth}.csv`)}
            className="px-3.5 py-2 rounded-xl bg-white border border-stone-200 text-sm font-medium flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" /> 导出费用汇总
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit">
        {isFinance && (
          <button
            onClick={() => setTab('payout')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
              tab === 'payout' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
            }`}
          >
            待打款核销队列 ({queue.length})
          </button>
        )}
        <button
          onClick={() => setTab('budgets')}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
            tab === 'budgets' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
          }`}
        >
          门店月度预算管理
        </button>
        <button
          onClick={() => setTab('reports')}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
            tab === 'reports' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
          }`}
        >
          费用统计分析报表
        </button>
      </div>

      {tab === 'payout' && isFinance && (
        <div className="space-y-3">
          <div className="flex items-center justify-between bg-white p-4 rounded-2xl border border-stone-200">
            <span className="text-sm text-stone-600">
              已勾选 <strong className="text-stone-900">{selectedIds.length}</strong> 笔待打款报销单，合计实付{' '}
              <strong className="text-brand-700 tabular-nums">
                {formatMoney(
                  queue
                    .filter((q) => selectedIds.includes(q.id))
                    .reduce((s, q) => s + Number(q.net_pay_amount), 0)
                )}
              </strong>
            </span>
            <button
              disabled={selectedIds.length === 0}
              onClick={() => {
                setPaymentRef(`TXN-${Date.now().toString().slice(-8)}`);
                setPayoutOpen(true);
              }}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold disabled:opacity-40 flex items-center gap-1.5"
            >
              <CreditCard className="w-4 h-4" /> 批量登记打款核销
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
            <table className="w-full text-sm text-left">
              <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={queue.length > 0 && selectedIds.length === queue.length}
                      onChange={(e) =>
                        setSelectedIds(e.target.checked ? queue.map((q) => q.id) : [])
                      }
                    />
                  </th>
                  <th className="px-4 py-3">单号 / 标题</th>
                  <th className="px-4 py-3">门店 / 报销人</th>
                  <th className="px-4 py-3">收款账户（对公/对私）</th>
                  <th className="px-4 py-3 text-right">报销总额</th>
                  <th className="px-4 py-3 text-right">冲销借款</th>
                  <th className="px-4 py-3 text-right">本次实付</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {queue.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-stone-400">
                      暂无待打款单据
                    </td>
                  </tr>
                ) : (
                  queue.map((q) => (
                    <tr key={q.id} className="hover:bg-stone-50/70">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(q.id)}
                          onChange={(e) =>
                            setSelectedIds((prev) =>
                              e.target.checked ? [...prev, q.id] : prev.filter((x) => x !== q.id)
                            )
                          }
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-stone-900">{q.title}</div>
                        <div className="text-xs text-stone-400 font-mono">{q.claim_no}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{q.hotel_name}</div>
                        <div className="text-xs text-stone-500">{q.applicant_name}</div>
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-1.5 py-0.5 rounded font-medium ${
                              q.payment_type === 'CORPORATE'
                                ? 'bg-indigo-50 text-indigo-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {q.payment_type === 'CORPORATE' ? '对公' : '对私'}
                          </span>
                          <span className="font-medium text-stone-900">{q.payee_name}</span>
                        </div>
                        <div className="text-stone-500 mt-0.5 font-mono">
                          {q.payee_bank || '-'} · {q.payee_account || '-'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatMoney(q.total_amount)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-sky-700">
                        {formatMoney(q.offset_amount)}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-brand-700 tabular-nums">
                        {formatMoney(q.net_pay_amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'budgets' && (
        <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden shadow-sm">
          <table className="w-full text-sm text-left">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
              <tr>
                <th className="px-5 py-3">门店</th>
                <th className="px-4 py-3">费用科目</th>
                <th className="px-4 py-3 text-right">月度预算</th>
                <th className="px-4 py-3 text-right">已占用(含审批中)</th>
                <th className="px-4 py-3 text-right">剩余可用</th>
                <th className="px-4 py-3 w-48">执行率</th>
                {['HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'].includes(user?.role || '') && (
                  <th className="px-4 py-3 text-right">调整</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {budgets.map((b) => (
                <tr key={`${b.hotel_id}-${b.category}`} className="hover:bg-stone-50/70">
                  <td className="px-5 py-3 font-medium text-stone-900">{b.hotel_name}</td>
                  <td className="px-4 py-3 text-stone-700">{b.category_label}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {formatMoney(b.budget_amount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-stone-700">
                    {formatMoney(b.used_amount)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right tabular-nums font-semibold ${
                      b.is_over_budget ? 'text-rose-600' : 'text-emerald-700'
                    }`}
                  >
                    {formatMoney(b.remaining_amount)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-stone-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            b.is_over_budget ? 'bg-rose-500' : b.utilization_pct > 80 ? 'bg-amber-500' : 'bg-brand-500'
                          }`}
                          style={{ width: `${Math.min(100, b.utilization_pct)}%` }}
                        />
                      </div>
                      <span className="text-xs tabular-nums text-stone-600 w-12 text-right">
                        {b.utilization_pct}%
                      </span>
                    </div>
                  </td>
                  {['HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER'].includes(user?.role || '') && (
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => {
                          setEditingBudget(b);
                          setBudgetAmountInput(b.budget_amount);
                        }}
                        className="p-1.5 rounded-lg text-stone-500 hover:text-brand-700 hover:bg-brand-50"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'reports' && report && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
            <h3 className="text-base font-semibold text-stone-900 mb-4">各门店费用对比（{report.yearMonth}）</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={report.byHotel}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E7E5E4" />
                  <XAxis dataKey="hotel_name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                  <Bar dataKey="total_amount" name="报销总额" fill="#B47B38" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200 p-5 shadow-sm">
            <h3 className="text-base font-semibold text-stone-900 mb-4">费用科目占比分布</h3>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={report.byCategory}
                    dataKey="total_amount"
                    nameKey="category_label"
                    cx="50%"
                    cy="50%"
                    outerRadius={95}
                    label={(e) => e.category_label}
                  >
                    {report.byCategory.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => formatMoney(v)} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      <Modal open={payoutOpen} onClose={() => setPayoutOpen(false)} title="登记财务打款核销">
        <form onSubmit={handleBatchPayout} className="space-y-4">
          <div className="text-xs text-stone-600">
            确认对选中的 <strong>{selectedIds.length}</strong> 笔报销单完成打款？如关联了备用金冲销，系统将自动扣减借款余额。
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">打款渠道</label>
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
            >
              <option value="BANK_TRANSFER">银企直连 / 对公银行转账</option>
              <option value="ALIPAY_CORP">企业支付宝</option>
              <option value="WECHAT_CORP">企业微信零钱</option>
              <option value="CASH">门店现金核销</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">银行/平台交易流水号</label>
            <input
              type="text"
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setPayoutOpen(false)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认打款
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(editingBudget)}
        onClose={() => setEditingBudget(null)}
        title="调整门店月度预算"
        subtitle={editingBudget ? `${editingBudget.hotel_name} · ${editingBudget.category_label}` : ''}
      >
        <form onSubmit={handleSaveBudget} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">月度预算额度（元）</label>
            <input
              type="number"
              min="0"
              step="100"
              value={budgetAmountInput}
              onChange={(e) => setBudgetAmountInput(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm tabular-nums"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingBudget(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存预算
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
