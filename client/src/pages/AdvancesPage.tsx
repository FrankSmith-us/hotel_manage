import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banknote, Check, Pencil, Plus, RotateCcw, Undo2, XCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ACTION_LABEL_MAP, formatMoney, todayStr } from '../lib/format';

interface StepSummary {
  step_order: number;
  step_name: string;
  status: string;
  actor_name: string | null;
}

interface AdvanceRow {
  id: number;
  advance_no: string;
  hotel_id?: number;
  hotel_name: string;
  applicant_name: string;
  advance_type: string;
  amount: number;
  offset_amount: number;
  repaid_amount?: number;
  available_balance: number;
  purpose: string;
  expected_settle_date: string;
  payee_name?: string | null;
  payee_bank?: string | null;
  payee_account?: string | null;
  is_overdue?: boolean;
  urgency?: 'NORMAL' | 'URGENT';
  status: string;
  current_step_name: string | null;
  status_detail?: string;
  my_last_action?: string | null;
  steps?: StepSummary[];
  payment_ref: string | null;
  canApprove: boolean;
  canWithdraw?: boolean;
  canEdit?: boolean;
  canRepay?: boolean;
}

export function AdvancesPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<'all' | 'mine' | 'pending' | 'handled'>(
    initialTab === 'mine' || initialTab === 'pending' || initialTab === 'handled' ? initialTab : 'all'
  );
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [hotels, setHotels] = useState<Array<{ id: number; name: string }>>([]);
  const [open, setOpen] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [hotelId, setHotelId] = useState<number>(user?.hotel_id || 0);
  const [advanceType, setAdvanceType] = useState<'PETTY_CASH' | 'TRAVEL'>('PETTY_CASH');
  const [amount, setAmount] = useState(1500);
  const [purpose, setPurpose] = useState('');
  const [settleDate, setSettleDate] = useState(todayStr());
  const [payeeName, setPayeeName] = useState(user?.display_name || '');
  const [payeeBank, setPayeeBank] = useState('');
  const [payeeAccount, setPayeeAccount] = useState('');
  const [urgency, setUrgency] = useState<'NORMAL' | 'URGENT'>('NORMAL');
  const [actingId, setActingId] = useState<number | null>(null);

  const [disburseId, setDisburseId] = useState<number | null>(null);
  const [paymentRef, setPaymentRef] = useState('');

  const [repayRow, setRepayRow] = useState<AdvanceRow | null>(null);
  const [repayAmount, setRepayAmount] = useState(0);
  const [repayMethod, setRepayMethod] = useState<'BANK_TRANSFER' | 'CASH' | 'SALARY_DEDUCTION'>('BANK_TRANSFER');
  const [repayRef, setRepayRef] = useState('');
  const [repayRemark, setRepayRemark] = useState('');

  const load = useCallback(async () => {
    const data = await apiFetch<{ advances: AdvanceRow[] }>(`/api/advances?tab=${tab}`);
    setRows(data.advances);
  }, [tab]);

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t === 'all' || t === 'mine' || t === 'pending' || t === 'handled') {
      setTab(t);
    }
  }, [searchParams]);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  useEffect(() => {
    setPayeeName(user?.display_name || '');
    apiFetch<{ hotels: Array<{ id: number; name: string }> }>('/api/organization/hotels').then((d) => {
      setHotels(d.hotels);
      if (user?.hotel_id) setHotelId(user.hotel_id);
      else if (d.hotels.length > 0) setHotelId(d.hotels[0].id);
    });
  }, [user?.hotel_id, user?.display_name]);

  const openCreateModal = () => {
    setEditingId(null);
    setAdvanceType('PETTY_CASH');
    setAmount(1500);
    setPurpose('');
    setSettleDate(todayStr());
    setPayeeName(user?.display_name || '');
    setPayeeBank('');
    setPayeeAccount('');
    setUrgency('NORMAL');
    setOpen(true);
  };

  const openEditModal = (r: AdvanceRow) => {
    setEditingId(r.id);
    if (r.hotel_id) setHotelId(r.hotel_id);
    setAdvanceType((r.advance_type as 'PETTY_CASH' | 'TRAVEL') || 'PETTY_CASH');
    setAmount(Number(r.amount));
    setPurpose(r.purpose);
    setSettleDate(r.expected_settle_date);
    setPayeeName(r.payee_name || user?.display_name || '');
    setPayeeBank(r.payee_bank || '');
    setPayeeAccount(r.payee_account || '');
    setUrgency(r.urgency === 'URGENT' ? 'URGENT' : 'NORMAL');
    setOpen(true);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        hotel_id: hotelId,
        advance_type: advanceType,
        amount: Number(amount),
        purpose,
        expected_settle_date: settleDate,
        payee_name: payeeName,
        payee_bank: payeeBank,
        payee_account: payeeAccount,
        urgency,
      };
      if (editingId) {
        await apiFetch(`/api/advances/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        showToast('借款单已修改并重新提交');
      } else {
        await apiFetch('/api/advances', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        showToast('借款/备用金申请已提交');
      }
      setOpen(false);
      setEditingId(null);
      setPurpose('');
      setUrgency('NORMAL');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交失败', 'error');
    }
  };

  const handleAction = async (id: number, action: 'APPROVE' | 'REJECT' | 'RETURN') => {
    setActingId(id);
    try {
      const comment = action === 'APPROVE' ? '同意' : action === 'RETURN' ? '退回修改' : '驳回';
      await apiFetch(`/api/advances/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, comment }),
      });
      showToast(action === 'APPROVE' ? '审批已通过' : action === 'RETURN' ? '已退回申请人修改' : '已驳回');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setActingId(null);
    }
  };

  const handleWithdraw = async (id: number) => {
    setActingId(id);
    try {
      await apiFetch(`/api/advances/${id}/withdraw`, { method: 'POST' });
      showToast('借款单已撤回');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '撤回失败', 'error');
    } finally {
      setActingId(null);
    }
  };

  const handleDisburse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!disburseId) return;
    try {
      await apiFetch(`/api/advances/${disburseId}/disburse`, {
        method: 'POST',
        body: JSON.stringify({ payment_ref: paymentRef }),
      });
      showToast('已确认放款，员工报销时可关联冲销');
      setDisburseId(null);
      setPaymentRef('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '放款失败', 'error');
    }
  };

  const handleRepay = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repayRow) return;
    try {
      await apiFetch(`/api/advances/${repayRow.id}/repay`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(repayAmount),
          repayment_method: repayMethod,
          payment_ref: repayRef,
          remark: repayRemark,
        }),
      });
      showToast('还款登记成功');
      setRepayRow(null);
      setRepayRef('');
      setRepayRemark('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '还款登记失败', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">门店备用金与借款管理</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            预支门店零星采购备用金或差旅借款，放款后可在费用报销单中自动抵扣冲销
          </p>
        </div>
        <button
          onClick={openCreateModal}
          className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> 申请备用金/借款
        </button>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit flex-wrap">
        {[
          { key: 'all', label: '全部借款单' },
          { key: 'pending', label: '待我审批' },
          { key: 'mine', label: '我的申请' },
          { key: 'handled', label: '我审批过的' },
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
          <thead className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-stone-500">
            <tr>
              <th className="px-5 py-3.5">借款单号 / 用途</th>
              <th className="px-4 py-3.5">门店 / 申请人</th>
              <th className="px-4 py-3.5">类型</th>
              <th className="px-4 py-3.5 text-right">借款金额</th>
              <th className="px-4 py-3.5 text-right">已冲销 / 剩余可冲</th>
              <th className="px-4 py-3.5">状态</th>
              <th className="px-5 py-3.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-stone-50/70">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-1.5">
                    {r.urgency === 'URGENT' && (
                      <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-600 border border-red-200 text-[11px] font-bold">
                        紧急
                      </span>
                    )}
                    <span className={`font-semibold ${r.urgency === 'URGENT' ? 'text-red-600' : 'text-stone-900'}`}>
                      {r.purpose}
                    </span>
                  </div>
                  <div className="text-xs text-stone-400 font-mono">{r.advance_no}</div>
                </td>
                <td className="px-4 py-3.5">
                  <div className="text-stone-800">{r.hotel_name}</div>
                  <div className="text-xs text-stone-500">{r.applicant_name}</div>
                </td>
                <td className="px-4 py-3.5 text-xs text-stone-600">
                  {r.advance_type === 'PETTY_CASH' ? '门店备用金' : '差旅预支'}
                </td>
                <td className="px-4 py-3.5 text-right font-semibold tabular-nums">{formatMoney(r.amount)}</td>
                <td className="px-4 py-3.5 text-right tabular-nums text-xs">
                  <div>已冲 {formatMoney(r.offset_amount)}</div>
                  {Number(r.repaid_amount || 0) > 0 && (
                    <div className="text-emerald-700">已还 {formatMoney(r.repaid_amount)}</div>
                  )}
                  <div className="text-sky-700 font-medium">余 {formatMoney(r.available_balance)}</div>
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StatusBadge status={r.status} />
                    {r.is_overdue && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                        已逾期({r.expected_settle_date})
                      </span>
                    )}
                    {r.my_last_action && (
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {ACTION_LABEL_MAP[r.my_last_action] || r.my_last_action}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-stone-500 mt-1">
                    {r.status_detail || r.current_step_name || ''}
                  </div>
                  {r.steps && r.steps.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {r.steps.map((s) => (
                        <span
                          key={s.step_order}
                          className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            s.status === 'APPROVED'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : s.status === 'PENDING'
                                ? 'bg-amber-50 text-amber-700 border-amber-200'
                                : s.status === 'REJECTED'
                                  ? 'bg-rose-50 text-rose-700 border-rose-200'
                                  : 'bg-stone-50 text-stone-400 border-stone-200'
                          }`}
                        >
                          {s.step_order}.{s.step_name}
                          {s.actor_name ? `(${s.actor_name})` : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3.5 text-right space-x-1.5 whitespace-nowrap">
                  {r.canApprove && (
                    <>
                      <button
                        disabled={actingId === r.id}
                        onClick={() => handleAction(r.id, 'APPROVE')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" /> 通过
                      </button>
                      <button
                        disabled={actingId === r.id}
                        onClick={() => handleAction(r.id, 'RETURN')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-amber-200 text-amber-700 text-xs font-medium disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> 退回
                      </button>
                      <button
                        disabled={actingId === r.id}
                        onClick={() => handleAction(r.id, 'REJECT')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 text-rose-700 text-xs font-medium disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" /> 驳回
                      </button>
                    </>
                  )}
                  {r.canEdit && (
                    <button
                      onClick={() => openEditModal(r)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-brand-200 text-brand-700 text-xs font-medium"
                    >
                      <Pencil className="w-3.5 h-3.5" /> 修改重提
                    </button>
                  )}
                  {r.canWithdraw && (
                    <button
                      disabled={actingId === r.id}
                      onClick={() => handleWithdraw(r.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-stone-200 text-stone-600 text-xs font-medium disabled:opacity-50"
                    >
                      <Undo2 className="w-3.5 h-3.5" /> 撤回
                    </button>
                  )}
                  {r.status === 'APPROVED' && ['HQ_ADMIN', 'FINANCE'].includes(user?.role || '') && (
                    <button
                      onClick={() => {
                        setDisburseId(r.id);
                        setPaymentRef(`PAY-ADV-${Date.now().toString().slice(-6)}`);
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium"
                    >
                      <Banknote className="w-3.5 h-3.5" /> 财务放款
                    </button>
                  )}
                  {r.canRepay && (
                    <button
                      onClick={() => {
                        setRepayRow(r);
                        setRepayAmount(
                          Math.max(0, Number(r.amount) - Number(r.offset_amount || 0) - Number(r.repaid_amount || 0))
                        );
                        setRepayMethod('BANK_TRANSFER');
                        setRepayRef(`REP-${Date.now().toString().slice(-6)}`);
                        setRepayRemark('');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-sky-200 text-sky-700 text-xs font-medium"
                    >
                      登记还款
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={open} onClose={() => { setOpen(false); setEditingId(null); }} title={editingId ? '修改并重提借款单' : '申请备用金 / 预支借款'}>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">归属门店</label>
              <select
                value={hotelId}
                onChange={(e) => setHotelId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">借款类型</label>
              <select
                value={advanceType}
                onChange={(e) => setAdvanceType(e.target.value as 'PETTY_CASH' | 'TRAVEL')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="PETTY_CASH">门店备用金</option>
                <option value="TRAVEL">差旅预支借款</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">借款金额(元)</label>
              <input
                type="number"
                min="1"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">预计冲销日期</label>
              <input
                type="date"
                value={settleDate}
                onChange={(e) => setSettleDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
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
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">收款人(本人)</label>
              <input
                type="text"
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-stone-50"
                readOnly
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">开户行</label>
              <input
                type="text"
                value={payeeBank}
                onChange={(e) => setPayeeBank(e.target.value)}
                placeholder="如：招商银行静安支行"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">收款账号</label>
              <input
                type="text"
                value={payeeAccount}
                onChange={(e) => setPayeeAccount(e.target.value)}
                placeholder="银行卡号"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">借款用途说明</label>
            <textarea
              rows={2}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="请说明备用金或差旅预支用途"
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setEditingId(null); }}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              {editingId ? '保存并重提' : '提交审批'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(repayRow)} onClose={() => setRepayRow(null)} title="登记借款还款">
        <form onSubmit={handleRepay} className="space-y-4">
          <div className="text-xs text-stone-500">
            借款单：<span className="font-mono text-stone-800">{repayRow?.advance_no}</span>（{repayRow?.applicant_name}）
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">还款金额(元)</label>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={repayAmount}
                onChange={(e) => setRepayAmount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">还款方式</label>
              <select
                value={repayMethod}
                onChange={(e) => setRepayMethod(e.target.value as 'BANK_TRANSFER' | 'CASH' | 'SALARY_DEDUCTION')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="BANK_TRANSFER">银行转账</option>
                <option value="CASH">现金交回</option>
                <option value="SALARY_DEDUCTION">薪资扣回</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">收款流水号</label>
            <input
              type="text"
              value={repayRef}
              onChange={(e) => setRepayRef(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">备注</label>
            <input
              type="text"
              value={repayRemark}
              onChange={(e) => setRepayRemark(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRepayRow(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认登记
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(disburseId)} onClose={() => setDisburseId(null)} title="确认借款放款">
        <form onSubmit={handleDisburse} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">财务打款流水号</label>
            <input
              type="text"
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDisburseId(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认放款
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
