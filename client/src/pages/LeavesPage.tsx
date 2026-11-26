import React, { useCallback, useEffect, useState } from 'react';
import { Check, Plus, XCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LEAVE_TYPE_MAP, todayStr } from '../lib/format';

interface LeaveRow {
  id: number;
  request_no: string;
  emp_name: string;
  position: string;
  hotel_name: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  days: number;
  hours: number;
  reason: string;
  urgency?: 'NORMAL' | 'URGENT';
  status: string;
  current_step_name: string | null;
  canApprove: boolean;
}

export function LeavesPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState<'all' | 'pending' | 'mine'>('all');
  const [rows, setRows] = useState<LeaveRow[]>([]);
  const [open, setOpen] = useState(false);

  const [leaveType, setLeaveType] = useState('ANNUAL');
  const [startDate, setStartDate] = useState(todayStr());
  const [endDate, setEndDate] = useState(todayStr());
  const [days, setDays] = useState(1);
  const [hours, setHours] = useState(8);
  const [reason, setReason] = useState('');
  const [urgency, setUrgency] = useState<'NORMAL' | 'URGENT'>('NORMAL');

  const load = useCallback(async () => {
    const d = await apiFetch<{ leaves: LeaveRow[] }>(`/api/leaves?tab=${tab}`);
    setRows(d.leaves);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/leaves', {
        method: 'POST',
        body: JSON.stringify({
          leave_type: leaveType,
          start_date: startDate,
          end_date: endDate,
          days: leaveType === 'OVERTIME' ? 0 : Number(days),
          hours: Number(hours),
          reason,
          urgency,
        }),
      });
      showToast('请假/加班申请已提交');
      setOpen(false);
      setReason('');
      setUrgency('NORMAL');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交失败', 'error');
    }
  };

  const handleAction = async (id: number, action: 'APPROVE' | 'REJECT') => {
    try {
      await apiFetch(`/api/leaves/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, comment: action === 'APPROVE' ? '同意' : '不同意' }),
      });
      showToast(action === 'APPROVE' ? '已审批通过' : '已驳回');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '审批失败', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">请假、调休与加班审批</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            审批通过的病/事假与加班小时数将自动联动月度薪资核算
          </p>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> 发起申请
        </button>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit">
        {[
          { key: 'all', label: '全部记录' },
          { key: 'pending', label: '待我审批' },
          { key: 'mine', label: '我的申请' },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as typeof tab)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
              tab === t.key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
            <tr>
              <th className="px-5 py-3.5">单号 / 申请人</th>
              <th className="px-4 py-3.5">门店</th>
              <th className="px-4 py-3.5">类型</th>
              <th className="px-4 py-3.5">起止日期 / 时长</th>
              <th className="px-4 py-3.5">事由</th>
              <th className="px-4 py-3.5">状态</th>
              <th className="px-5 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-stone-50/70">
                <td className="px-5 py-3.5">
                  <div className="font-semibold text-stone-900">
                    {r.emp_name} <span className="text-xs font-normal text-stone-500">({r.position})</span>
                  </div>
                  <div className="text-xs text-stone-400 font-mono">{r.request_no}</div>
                </td>
                <td className="px-4 py-3.5 text-stone-700">{r.hotel_name}</td>
                <td className="px-4 py-3.5 font-medium text-stone-800">
                  {LEAVE_TYPE_MAP[r.leave_type] || r.leave_type}
                </td>
                <td className="px-4 py-3.5 text-xs tabular-nums">
                  <div>
                    {r.start_date} ~ {r.end_date}
                  </div>
                  <div className="text-stone-500 mt-0.5">
                    {r.leave_type === 'OVERTIME' ? `${r.hours} 小时` : `${r.days} 天 (${r.hours}小时)`}
                  </div>
                </td>
                <td className="px-4 py-3.5 text-xs max-w-xs truncate">
                  {r.urgency === 'URGENT' && (
                    <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold mr-1.5">
                      紧急
                    </span>
                  )}
                  <span className={r.urgency === 'URGENT' ? 'text-red-600 font-semibold' : 'text-stone-600'}>
                    {r.reason}
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  <StatusBadge status={r.status} />
                  {r.current_step_name && (
                    <div className="text-[11px] text-stone-500 mt-1">{r.current_step_name}</div>
                  )}
                </td>
                <td className="px-5 py-3.5 text-right space-x-2">
                  {r.canApprove && (
                    <>
                      <button
                        onClick={() => handleAction(r.id, 'APPROVE')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                      >
                        <Check className="w-3.5 h-3.5" /> 同意
                      </button>
                      <button
                        onClick={() => handleAction(r.id, 'REJECT')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 text-rose-700 text-xs font-medium"
                      >
                        <XCircle className="w-3.5 h-3.5" /> 驳回
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="发起请假 / 加班申请">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">申请类型</label>
              <select
                value={leaveType}
                onChange={(e) => setLeaveType(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="ANNUAL">年假</option>
                <option value="SICK">病假</option>
                <option value="PERSONAL">事假</option>
                <option value="COMP_OFF">调休</option>
                <option value="OVERTIME">加班申请</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">开始日期</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">结束日期</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {leaveType !== 'OVERTIME' && (
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">请假天数</label>
                <input
                  type="number"
                  min="0.5"
                  step="0.5"
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">合计小时数</label>
              <input
                type="number"
                min="1"
                step="0.5"
                value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">紧急程度</label>
              <select
                value={urgency}
                onChange={(e) => setUrgency(e.target.value as 'NORMAL' | 'URGENT')}
                className={`w-full px-3 py-2 rounded-xl border text-sm bg-white ${
                  urgency === 'URGENT' ? 'border-red-300 text-red-600 font-semibold' : 'border-stone-300'
                }`}
              >
                <option value="NORMAL">常规</option>
                <option value="URGENT">紧急</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">事由说明</label>
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              提交审批
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
