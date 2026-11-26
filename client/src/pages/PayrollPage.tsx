import React, { useCallback, useEffect, useState } from 'react';
import { Calculator, CheckCircle2, Download, Edit3, Settings2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { currentYearMonth, formatMoney } from '../lib/format';

interface CitySsRule {
  id?: number;
  city: string;
  effective_year: number;
  ss_base_min: number;
  ss_base_max: number;
  pension_rate: number;
  medical_rate: number;
  unemployment_rate: number;
  housing_fund_rate: number;
  total_personal_rate: number;
}

interface PayrollRow {
  id: number;
  year_month: string;
  emp_no: string;
  emp_name: string;
  position: string;
  hotel_name: string;
  base_salary: number;
  night_shifts: number;
  night_allowance: number;
  overtime_hours: number;
  overtime_pay: number;
  leave_deduction_days: number;
  leave_deduction: number;
  performance_bonus: number;
  social_security: number;
  income_tax?: number;
  gross_pay: number;
  net_pay: number;
  status: string;
  notes: string | null;
}

export function PayrollPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canCalculate = ['HQ_ADMIN', 'HR_MANAGER'].includes(user?.role || '');
  const canEditOrConfirm = ['HQ_ADMIN', 'HR_MANAGER', 'FINANCE'].includes(user?.role || '');

  const [yearMonth, setYearMonth] = useState(currentYearMonth());
  const [records, setRecords] = useState<PayrollRow[]>([]);
  const [editing, setEditing] = useState<PayrollRow | null>(null);
  const [bonusInput, setBonusInput] = useState(0);
  const [notesInput, setNotesInput] = useState('');
  const [ssModalOpen, setSsModalOpen] = useState(false);
  const [ssRules, setSsRules] = useState<CitySsRule[]>([]);
  const [ssForm, setSsForm] = useState<CitySsRule>({
    city: '上海',
    effective_year: 2026,
    ss_base_min: 7384,
    ss_base_max: 36921,
    pension_rate: 0.08,
    medical_rate: 0.02,
    unemployment_rate: 0.005,
    housing_fund_rate: 0.07,
    total_personal_rate: 0.175,
  });

  const load = useCallback(async () => {
    const d = await apiFetch<{ records: PayrollRow[] }>(`/api/payroll?yearMonth=${yearMonth}`);
    setRecords(d.records);
  }, [yearMonth]);

  const openSsRules = async () => {
    try {
      const d = await apiFetch<{ rules: CitySsRule[] }>('/api/payroll/ss-rules');
      setSsRules(d.rules);
      if (d.rules.length > 0) setSsForm(d.rules[0]);
      setSsModalOpen(true);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载社保规则失败', 'error');
    }
  };

  const handleSaveSsRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/payroll/ss-rules', {
        method: 'PUT',
        body: JSON.stringify(ssForm),
      });
      showToast(`${ssForm.city} 社保公积金规则已更新`);
      const d = await apiFetch<{ rules: CitySsRule[] }>('/api/payroll/ss-rules');
      setSsRules(d.rules);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存社保规则失败', 'error');
    }
  };

  useEffect(() => {
    load();
  }, [load, user?.id]);

  const handleCalculate = async () => {
    try {
      const res = await apiFetch<{ processedCount: number; skippedConfirmedCount: number }>(
        '/api/payroll/calculate',
        {
          method: 'POST',
          body: JSON.stringify({ yearMonth }),
        }
      );
      showToast(`已完成 ${yearMonth} 薪资核算：生成/更新 ${res.processedCount} 条记录`);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '核算失败', 'error');
    }
  };

  const handleConfirmAll = async () => {
    try {
      const res = await apiFetch<{ confirmedCount: number }>('/api/payroll/confirm', {
        method: 'POST',
        body: JSON.stringify({ yearMonth }),
      });
      showToast(`已确认锁账 ${res.confirmedCount} 条薪资记录`);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '确认失败', 'error');
    }
  };

  const handleSaveBonus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await apiFetch(`/api/payroll/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          performance_bonus: Number(bonusInput),
          notes: notesInput || null,
        }),
      });
      showToast('绩效奖金已更新并重算实发工资');
      setEditing(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失败', 'error');
    }
  };

  const totalNet = records.reduce((s, r) => s + Number(r.net_pay), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">月度薪资核算台账</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            自动联动排班夜班天数（¥80/夜）、审批通过的加班工时与病事假扣款
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <input
            type="month"
            value={yearMonth}
            onChange={(e) => setYearMonth(e.target.value)}
            className="px-3 py-2 rounded-xl border border-stone-200 bg-white text-sm"
          />
          {canCalculate && (
            <button
              onClick={handleCalculate}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
            >
              <Calculator className="w-4 h-4" /> 一键核算本月薪资
            </button>
          )}
          {canEditOrConfirm && records.some((r) => r.status === 'DRAFT') && (
            <button
              onClick={handleConfirmAll}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold flex items-center gap-1.5"
            >
              <CheckCircle2 className="w-4 h-4" /> 确认锁账
            </button>
          )}
          {canEditOrConfirm && (
            <button
              onClick={openSsRules}
              className="px-3.5 py-2 rounded-xl bg-white border border-stone-200 text-sm font-medium flex items-center gap-1.5"
            >
              <Settings2 className="w-4 h-4" /> 城市社保规则
            </button>
          )}
          {user?.role !== 'STAFF' && (
            <button
              onClick={() => downloadCsv(`/api/payroll/export?yearMonth=${yearMonth}`, `payroll-${yearMonth}.csv`)}
              className="px-3.5 py-2 rounded-xl bg-white border border-stone-200 text-sm font-medium flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" /> 导出工资表
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200/90 p-4 flex items-center justify-between text-sm">
        <span className="text-stone-600">
          账期 <strong className="text-stone-900">{yearMonth}</strong> · 共 <strong>{records.length}</strong> 条工资条
        </span>
        <span className="text-stone-600">
          实发合计：<strong className="text-lg text-brand-700 tabular-nums">{formatMoney(totalNet)}</strong>
        </span>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-x-auto">
        <table className="w-full text-xs text-left min-w-[980px]">
          <thead className="bg-stone-50 border-b border-stone-200 text-stone-500">
            <tr>
              <th className="px-4 py-3">员工 / 门店</th>
              <th className="px-3 py-3 text-right">底薪</th>
              <th className="px-3 py-3 text-right">夜班(天) / 津贴</th>
              <th className="px-3 py-3 text-right">加班(h) / 加班费</th>
              <th className="px-3 py-3 text-right">请假扣款</th>
              <th className="px-3 py-3 text-right">绩效奖金</th>
              <th className="px-3 py-3 text-right">社保公积金</th>
              <th className="px-3 py-3 text-right">个税</th>
              <th className="px-3 py-3 text-right">实发工资</th>
              <th className="px-3 py-3">状态</th>
              {canEditOrConfirm && <th className="px-4 py-3 text-right">调整</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 tabular-nums">
            {records.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-12 text-center text-stone-400">
                  本月尚未核算薪资，点击右上角“一键核算本月薪资”自动生成
                </td>
              </tr>
            ) : (
              records.map((r) => (
                <tr key={r.id} className="hover:bg-stone-50/70">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-sm text-stone-900">{r.emp_name}</div>
                    <div className="text-stone-500">
                      {r.hotel_name} · {r.position}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">{formatMoney(r.base_salary)}</td>
                  <td className="px-3 py-3 text-right">
                    <div>{r.night_shifts} 天</div>
                    <div className="text-emerald-700">+{formatMoney(r.night_allowance)}</div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div>{r.overtime_hours} h</div>
                    <div className="text-emerald-700">+{formatMoney(r.overtime_pay)}</div>
                  </td>
                  <td className="px-3 py-3 text-right text-rose-600">-{formatMoney(r.leave_deduction)}</td>
                  <td className="px-3 py-3 text-right text-brand-700">+{formatMoney(r.performance_bonus)}</td>
                  <td className="px-3 py-3 text-right text-stone-500">-{formatMoney(r.social_security)}</td>
                  <td className="px-3 py-3 text-right text-stone-500">-{formatMoney(r.income_tax || 0)}</td>
                  <td className="px-3 py-3 text-right font-bold text-sm text-stone-900">
                    {formatMoney(r.net_pay)}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  {canEditOrConfirm && (
                    <td className="px-4 py-3 text-right">
                      {r.status === 'DRAFT' && (
                        <button
                          onClick={() => {
                            setEditing(r);
                            setBonusInput(r.performance_bonus);
                            setNotesInput(r.notes || '');
                          }}
                          className="p-1.5 rounded-lg text-stone-500 hover:text-brand-700 hover:bg-brand-50"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `调整绩效奖金 · ${editing.emp_name}` : ''}
      >
        <form onSubmit={handleSaveBonus} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">本月绩效奖金（元）</label>
            <input
              type="number"
              min="0"
              step="50"
              value={bonusInput}
              onChange={(e) => setBonusInput(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">备注</label>
            <input
              type="text"
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存重算
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={ssModalOpen} onClose={() => setSsModalOpen(false)} title="城市社保与公积金规则配置">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {ssRules.map((r) => (
              <button
                key={r.city}
                type="button"
                onClick={() => setSsForm(r)}
                className={`px-2.5 py-1 rounded-lg text-xs border ${
                  ssForm.city === r.city
                    ? 'bg-brand-50 text-brand-700 border-brand-200 font-semibold'
                    : 'bg-white text-stone-600 border-stone-200'
                }`}
              >
                {r.city} ({(Number(r.total_personal_rate) * 100).toFixed(1)}%)
              </button>
            ))}
          </div>
          <form onSubmit={handleSaveSsRule} className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-stone-600 mb-1">城市</label>
                <input
                  type="text"
                  value={ssForm.city}
                  onChange={(e) => setSsForm({ ...ssForm, city: e.target.value })}
                  className="w-full px-3 py-1.5 rounded-lg border border-stone-300 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-stone-600 mb-1">基数下限(元)</label>
                <input
                  type="number"
                  value={ssForm.ss_base_min}
                  onChange={(e) => setSsForm({ ...ssForm, ss_base_min: Number(e.target.value) })}
                  className="w-full px-3 py-1.5 rounded-lg border border-stone-300 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-xs text-stone-600 mb-1">基数上限(元)</label>
                <input
                  type="number"
                  value={ssForm.ss_base_max}
                  onChange={(e) => setSsForm({ ...ssForm, ss_base_max: Number(e.target.value) })}
                  className="w-full px-3 py-1.5 rounded-lg border border-stone-300 text-sm"
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="block text-[11px] text-stone-600 mb-1">养老比例</label>
                <input
                  type="number"
                  step="0.001"
                  value={ssForm.pension_rate}
                  onChange={(e) => setSsForm({ ...ssForm, pension_rate: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-stone-600 mb-1">医疗比例</label>
                <input
                  type="number"
                  step="0.001"
                  value={ssForm.medical_rate}
                  onChange={(e) => setSsForm({ ...ssForm, medical_rate: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-stone-600 mb-1">失业比例</label>
                <input
                  type="number"
                  step="0.001"
                  value={ssForm.unemployment_rate}
                  onChange={(e) => setSsForm({ ...ssForm, unemployment_rate: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-sm"
                />
              </div>
              <div>
                <label className="block text-[11px] text-stone-600 mb-1">公积金比例</label>
                <input
                  type="number"
                  step="0.001"
                  value={ssForm.housing_fund_rate}
                  onChange={(e) => setSsForm({ ...ssForm, housing_fund_rate: Number(e.target.value) })}
                  className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-sm"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setSsModalOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
                关闭
              </button>
              <button type="submit" className="px-4 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
                保存规则
              </button>
            </div>
          </form>
        </div>
      </Modal>
    </div>
  );
}
