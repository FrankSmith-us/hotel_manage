import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  FileText,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import { ApprovalLogView, ApprovalStepView, ApprovalTimeline } from '../components/ApprovalTimeline';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch, downloadCsv } from '../lib/api';
import { useAuth } from '../lib/auth';
import { currentYearMonth, EXPENSE_CATEGORIES, formatMoney, todayStr } from '../lib/format';

interface ReimbursementRow {
  id: number;
  claim_no: string;
  title: string;
  hotel_id: number;
  hotel_name: string;
  applicant_name: string;
  expense_month: string;
  total_amount: number;
  offset_amount: number;
  net_pay_amount: number;
  status: string;
  current_step: number;
  total_steps: number;
  current_step_name: string | null;
  risk_flags: string;
  risk_summary: string | null;
  canApprove: boolean;
  created_at: string;
}

interface ClaimItemForm {
  category: string;
  expense_date: string;
  description: string;
  amount: number;
  invoice_no: string;
  attachment_url: string;
  attachment_name: string;
}

interface PreviewResult {
  totalAmount: number;
  risks: {
    riskFlags: string[];
    riskSummary: string;
    overBudgetCategories: Array<{
      categoryLabel: string;
      budgetAmount: number;
      alreadyUsed: number;
      exceededBy: number;
    }>;
    duplicateInvoices: Array<{ invoiceNo: string; conflictClaimNos: string[] }>;
  };
  route: Array<{ stepOrder: number; stepName: string; roleLabel: string }>;
}

interface HotelOption {
  id: number;
  name: string;
  code: string;
}

interface AdvanceOption {
  id: number;
  advance_no: string;
  purpose: string;
  amount: number;
  available_balance: number;
}

interface ClaimDetail {
  claim: ReimbursementRow & {
    department_name: string | null;
    remarks: string | null;
    payee_name: string;
    payee_bank: string | null;
    payee_account: string | null;
    payment_channel: string | null;
    payment_ref: string | null;
    paid_at: string | null;
    cash_advance_id: number | null;
  };
  items: Array<ClaimItemForm & { id: number; category_label: string; is_duplicate_invoice: number }>;
  approvalSteps: ApprovalStepView[];
  approvalLogs: ApprovalLogView[];
  cashAdvance: { advance_no: string; purpose: string; amount: number } | null;
  permissions: { canApprove: boolean; canEdit: boolean; canWithdraw: boolean; canPay: boolean };
}

export function ReimbursementsPage() {
  const { user } = useAuth();
  const { showToast } = useToast();

  const [tab, setTab] = useState<'pending' | 'mine' | 'all'>('pending');
  const [statusFilter, setStatusFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [riskOnly, setRiskOnly] = useState(false);
  const [rows, setRows] = useState<ReimbursementRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [hotels, setHotels] = useState<HotelOption[]>([]);
  const [availableAdvances, setAvailableAdvances] = useState<AdvanceOption[]>([]);

  // Detail Drawer
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [comment, setComment] = useState('');
  const [acting, setActing] = useState(false);

  // Invoice Preview Modal
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Create/Edit Modal
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [hotelId, setHotelId] = useState<number>(user?.hotel_id || 2);
  const [expenseMonth, setExpenseMonth] = useState(currentYearMonth());
  const [cashAdvanceId, setCashAdvanceId] = useState<number | ''>('');
  const [offsetAmount, setOffsetAmount] = useState<number>(0);
  const [remarks, setRemarks] = useState('');
  const [items, setItems] = useState<ClaimItemForm[]>([
    {
      category: 'LINEN_SUPPLIES',
      expense_date: todayStr(),
      description: '',
      amount: 0,
      invoice_no: '',
      attachment_url: '',
      attachment_name: '',
    },
  ]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [saving, setSaving] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ tab });
      if (statusFilter) params.set('status', statusFilter);
      if (keyword.trim()) params.set('keyword', keyword.trim());
      if (riskOnly) params.set('riskOnly', 'true');
      const data = await apiFetch<{ reimbursements: ReimbursementRow[] }>(
        `/api/reimbursements?${params.toString()}`
      );
      setRows(data.reimbursements);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载报销列表失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, statusFilter, keyword, riskOnly, showToast]);

  useEffect(() => {
    loadList();
  }, [loadList, user?.id]);

  useEffect(() => {
    apiFetch<{ hotels: HotelOption[] }>('/api/organization/hotels').then((d) => {
      setHotels(d.hotels);
      if (user?.hotel_id) setHotelId(user.hotel_id);
      else if (d.hotels.length > 0) setHotelId(d.hotels[0].id);
    });
  }, [user?.hotel_id]);

  // Live preview call whenever items / hotelId / expenseMonth change in modal
  useEffect(() => {
    if (!formOpen || !hotelId) return;
    const timer = setTimeout(() => {
      apiFetch<PreviewResult>('/api/reimbursements/preview', {
        method: 'POST',
        body: JSON.stringify({
          hotel_id: hotelId,
          expense_month: expenseMonth,
          exclude_id: editingId ?? undefined,
          items: items.map((it) => ({
            category: it.category,
            amount: Number(it.amount || 0),
            invoice_no: it.invoice_no,
          })),
        }),
      })
        .then(setPreview)
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [formOpen, hotelId, expenseMonth, items, editingId]);

  const loadAdvancesForHotel = async (hid: number) => {
    try {
      const data = await apiFetch<{ advances: AdvanceOption[] }>(
        `/api/advances?tab=available&hotelId=${hid}`
      );
      setAvailableAdvances(data.advances);
    } catch {
      setAvailableAdvances([]);
    }
  };

  const openCreateModal = () => {
    const defaultHid = user?.hotel_id || hotels[0]?.id || 2;
    setEditingId(null);
    setTitle('');
    setHotelId(defaultHid);
    setExpenseMonth(currentYearMonth());
    setCashAdvanceId('');
    setOffsetAmount(0);
    setRemarks('');
    setItems([
      {
        category: 'LINEN_SUPPLIES',
        expense_date: todayStr(),
        description: '',
        amount: 0,
        invoice_no: '',
        attachment_url: '',
        attachment_name: '',
      },
    ]);
    loadAdvancesForHotel(defaultHid);
    setFormOpen(true);
  };

  const openEditFromDetail = (d: ClaimDetail) => {
    setEditingId(d.claim.id);
    setTitle(d.claim.title);
    setHotelId(d.claim.hotel_id);
    setExpenseMonth(d.claim.expense_month);
    setCashAdvanceId(d.claim.cash_advance_id ?? '');
    setOffsetAmount(Number(d.claim.offset_amount || 0));
    setRemarks(d.claim.remarks || '');
    setItems(
      d.items.map((it) => ({
        category: it.category,
        expense_date: it.expense_date,
        description: it.description,
        amount: Number(it.amount),
        invoice_no: it.invoice_no || '',
        attachment_url: it.attachment_url || '',
        attachment_name: it.attachment_name || '',
      }))
    );
    loadAdvancesForHotel(d.claim.hotel_id);
    setDetail(null);
    setFormOpen(true);
  };

  const openDetail = async (id: number) => {
    try {
      const data = await apiFetch<ClaimDetail>(`/api/reimbursements/${id}`);
      setDetail(data);
      setComment('');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载详情失败', 'error');
    }
  };

  const handleUploadAttachment = async (idx: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await apiFetch<{ url: string; originalName: string }>('/api/reimbursements/upload', {
        method: 'POST',
        body: fd,
      });
      setItems((prev) =>
        prev.map((it, i) =>
          i === idx ? { ...it, attachment_url: res.url, attachment_name: res.originalName } : it
        )
      );
      showToast('发票凭证上传成功');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '上传失败', 'error');
    }
  };

  const handleSave = async (submit: boolean) => {
    if (!title.trim()) {
      showToast('请填写报销单标题', 'error');
      return;
    }
    if (items.some((it) => !it.description.trim() || Number(it.amount) <= 0)) {
      showToast('请完善每条费用明细的说明与金额（须大于 0）', 'error');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        hotel_id: hotelId,
        expense_month: expenseMonth,
        cash_advance_id: cashAdvanceId === '' ? null : Number(cashAdvanceId),
        offset_amount: Number(offsetAmount || 0),
        remarks: remarks.trim() || null,
        submit,
        items: items.map((it) => ({
          ...it,
          amount: Number(it.amount),
          invoice_no: it.invoice_no.trim() || null,
          attachment_url: it.attachment_url || null,
          attachment_name: it.attachment_name || null,
        })),
      };

      if (editingId) {
        await apiFetch(`/api/reimbursements/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/reimbursements', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      showToast(submit ? '报销单已提交审批' : '已保存为草稿');
      setFormOpen(false);
      await loadList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleWorkflowAction = async (action: 'APPROVE' | 'RETURN' | 'REJECT') => {
    if (!detail) return;
    if ((action === 'RETURN' || action === 'REJECT') && comment.trim().length < 2) {
      showToast('退回或驳回时请填写审批意见', 'error');
      return;
    }
    setActing(true);
    try {
      await apiFetch(`/api/reimbursements/${detail.claim.id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, comment }),
      });
      showToast(
        action === 'APPROVE' ? '审批已通过' : action === 'RETURN' ? '已退回申请人修改' : '已驳回'
      );
      setDetail(null);
      await loadList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setActing(false);
    }
  };

  const handleWithdraw = async (id: number) => {
    try {
      await apiFetch(`/api/reimbursements/${id}/withdraw`, { method: 'POST' });
      showToast('已撤回至草稿');
      setDetail(null);
      await loadList();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '撤回失败', 'error');
    }
  };

  const totalFormAmount = items.reduce((s, it) => s + Number(it.amount || 0), 0);
  const netPayPreview = Math.max(0, totalFormAmount - Number(offsetAmount || 0));

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">费用报销中心</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            支持多明细发票上传、预算超标与重复发票实时风控、备用金自动冲销及多级动态审批
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {['HQ_ADMIN', 'FINANCE', 'GENERAL_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'].includes(
            user?.role || ''
          ) && (
            <button
              onClick={() => downloadCsv('/api/reimbursements/export', 'reimbursements.csv')}
              className="px-3.5 py-2 rounded-xl bg-white border border-stone-200 hover:border-stone-300 text-stone-700 text-sm font-medium flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>导出台账</span>
            </button>
          )}
          <button
            onClick={openCreateModal}
            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5 shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>新建报销单</span>
          </button>
        </div>
      </div>

      {/* Tabs & Filters */}
      <div className="bg-white rounded-2xl border border-stone-200/90 p-4 shadow-sm flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl w-fit">
          {[
            { key: 'pending', label: '待我审批' },
            { key: 'mine', label: '我的报销' },
            { key: 'all', label: '全部报销单' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as typeof tab)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                tab === t.key
                  ? 'bg-white text-stone-900 shadow-sm'
                  : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜单号 / 标题 / 报销人"
              className="pl-9 pr-3 py-1.5 rounded-xl border border-stone-200 text-sm w-48 focus:outline-none focus:border-brand-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-3 py-1.5 rounded-xl border border-stone-200 text-sm bg-white"
          >
            <option value="">全部状态</option>
            <option value="DRAFT">草稿</option>
            <option value="PENDING_APPROVAL">审批中</option>
            <option value="RETURNED">已退回修改</option>
            <option value="APPROVED">待打款</option>
            <option value="PAID">已打款核销</option>
            <option value="REJECTED">已驳回</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs font-medium text-stone-700 px-2.5 py-1.5 rounded-xl border border-stone-200 cursor-pointer">
            <input
              type="checkbox"
              checked={riskOnly}
              onChange={(e) => setRiskOnly(e.target.checked)}
              className="rounded text-brand-600"
            />
            <span>仅看风控预警</span>
          </label>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs font-semibold text-stone-500">
              <tr>
                <th className="px-5 py-3.5">单号 / 报销标题</th>
                <th className="px-4 py-3.5">门店 / 报销人</th>
                <th className="px-4 py-3.5">费用月份</th>
                <th className="px-4 py-3.5 text-right">报销总额</th>
                <th className="px-4 py-3.5 text-right">冲销 / 实付</th>
                <th className="px-4 py-3.5">风控标签</th>
                <th className="px-4 py-3.5">状态 / 当前节点</th>
                <th className="px-5 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-stone-400">
                    加载中...
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-stone-400">
                    当前筛选条件下暂无报销单据
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => openDetail(r.id)}
                    className="hover:bg-stone-50/80 cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-3.5">
                      <div className="font-semibold text-stone-900">{r.title}</div>
                      <div className="text-xs text-stone-400 font-mono mt-0.5">{r.claim_no}</div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="text-stone-800">{r.hotel_name}</div>
                      <div className="text-xs text-stone-500">{r.applicant_name}</div>
                    </td>
                    <td className="px-4 py-3.5 text-stone-600 tabular-nums">{r.expense_month}</td>
                    <td className="px-4 py-3.5 text-right font-semibold text-stone-900 tabular-nums">
                      {formatMoney(r.total_amount)}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums">
                      {Number(r.offset_amount) > 0 && (
                        <div className="text-xs text-sky-700">冲 {formatMoney(r.offset_amount)}</div>
                      )}
                      <div className="text-xs font-medium text-stone-700">
                        实付 {formatMoney(r.net_pay_amount)}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {r.risk_flags.includes('OVER_BUDGET') && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 text-rose-700 border border-rose-200">
                            超预算
                          </span>
                        )}
                        {r.risk_flags.includes('DUPLICATE_INVOICE') && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 text-orange-700 border border-orange-200">
                            重复发票
                          </span>
                        )}
                        {!r.risk_flags && <span className="text-xs text-stone-400">正常</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <StatusBadge status={r.status} />
                      {r.current_step_name && (
                        <div className="text-[11px] text-stone-500 mt-1">
                          第{r.current_step}/{r.total_steps}步：{r.current_step_name}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(r.id);
                        }}
                        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-stone-100 hover:bg-brand-50 hover:text-brand-800 text-stone-700 transition-colors"
                      >
                        {r.canApprove ? '去审批' : '查看详情'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingId ? '编辑报销单' : '新建费用报销单'}
        subtitle="系统将实时校验门店月度预算、重复发票号，并动态计算审批路由"
        maxWidth="max-w-4xl"
      >
        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-stone-700 mb-1">报销单标题 *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：上海静安店11月客房布草补货"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">费用归属月份 *</label>
              <input
                type="month"
                value={expenseMonth}
                onChange={(e) => setExpenseMonth(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">归属门店 *</label>
              <select
                value={hotelId}
                onChange={(e) => {
                  const hid = Number(e.target.value);
                  setHotelId(hid);
                  loadAdvancesForHotel(hid);
                }}
                disabled={Boolean(user?.hotel_id && user.role === 'STAFF')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.code})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">备注说明</label>
              <input
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="选填：采购背景或特殊说明"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          </div>

          {/* Line Items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-stone-700">费用明细（支持多科目与发票上传）</span>
              <button
                type="button"
                onClick={() =>
                  setItems((prev) => [
                    ...prev,
                    {
                      category: 'OTHER',
                      expense_date: todayStr(),
                      description: '',
                      amount: 0,
                      invoice_no: '',
                      attachment_url: '',
                      attachment_name: '',
                    },
                  ])
                }
                className="text-xs font-semibold text-brand-700 hover:text-brand-800 flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> 添加明细行
              </button>
            </div>

            <div className="space-y-2.5">
              {items.map((it, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl border border-stone-200 bg-stone-50/70 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end"
                >
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] text-stone-500 mb-1">费用科目</label>
                    <select
                      value={it.category}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, category: e.target.value } : x))
                        )
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-xs bg-white"
                    >
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] text-stone-500 mb-1">发生日期</label>
                    <input
                      type="date"
                      value={it.expense_date}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, expense_date: e.target.value } : x))
                        )
                      }
                      className="w-full px-2 py-1.5 rounded-lg border border-stone-300 text-xs bg-white"
                    />
                  </div>
                  <div className="sm:col-span-3">
                    <label className="block text-[11px] text-stone-500 mb-1">费用说明 *</label>
                    <input
                      type="text"
                      value={it.description}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, description: e.target.value } : x))
                        )
                      }
                      placeholder="采购/维保内容"
                      className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-xs bg-white"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] text-stone-500 mb-1">金额(元) *</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={it.amount || ''}
                      onChange={(e) =>
                        setItems((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, amount: Number(e.target.value) } : x))
                        )
                      }
                      className="w-full px-2.5 py-1.5 rounded-lg border border-stone-300 text-xs bg-white tabular-nums"
                    />
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-1">
                    <div className="flex-1">
                      <label className="block text-[11px] text-stone-500 mb-1">发票号</label>
                      <input
                        type="text"
                        value={it.invoice_no}
                        onChange={(e) =>
                          setItems((prev) =>
                            prev.map((x, i) => (i === idx ? { ...x, invoice_no: e.target.value } : x))
                          )
                        }
                        placeholder="选填查重"
                        className="w-full px-2 py-1.5 rounded-lg border border-stone-300 text-xs bg-white"
                      />
                    </div>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-1.5 text-stone-400 hover:text-rose-600"
                        title="删除行"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  <div className="sm:col-span-12 flex items-center justify-between pt-1">
                    <label className="inline-flex items-center gap-1.5 text-xs text-brand-700 hover:text-brand-800 cursor-pointer font-medium">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{it.attachment_name ? `已上传：${it.attachment_name}` : '上传发票图片/PDF'}</span>
                      <input
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp,.pdf,.svg"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleUploadAttachment(idx, f);
                        }}
                      />
                    </label>
                    {it.attachment_url && (
                      <button
                        type="button"
                        onClick={() => setPreviewUrl(it.attachment_url)}
                        className="text-xs text-stone-600 hover:text-stone-900 underline"
                      >
                        预览凭证
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Cash Advance Offset */}
          <div className="p-4 rounded-xl border border-stone-200 bg-stone-50/50 grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-stone-700 mb-1">
                关联备用金/借款冲销（可选）
              </label>
              <select
                value={cashAdvanceId}
                onChange={(e) => {
                  const val = e.target.value ? Number(e.target.value) : '';
                  setCashAdvanceId(val);
                  if (val === '') {
                    setOffsetAmount(0);
                  } else {
                    const adv = availableAdvances.find((a) => a.id === val);
                    if (adv) {
                      setOffsetAmount(Math.min(totalFormAmount, adv.available_balance));
                    }
                  }
                }}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="">不冲销借款（全额打款）</option>
                {availableAdvances.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.advance_no} · {a.purpose}（可冲销 {formatMoney(a.available_balance)}）
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">本次冲销金额</label>
              <input
                type="number"
                min="0"
                step="0.01"
                disabled={cashAdvanceId === ''}
                value={offsetAmount || ''}
                onChange={(e) => setOffsetAmount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white disabled:bg-stone-100 tabular-nums"
              />
            </div>
          </div>

          {/* Real-time Risk & Route Preview */}
          {preview && (
            <div className="space-y-3">
              {preview.risks.riskFlags.length > 0 && (
                <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 space-y-1">
                  <div className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-rose-600" />
                    <span>实时风控校验提醒（仍可提交，系统将自动升级审批或标红提示）</span>
                  </div>
                  {preview.risks.overBudgetCategories.map((c, i) => (
                    <div key={i}>
                      • {c.categoryLabel}：本月预算 {formatMoney(c.budgetAmount)}，已占用{' '}
                      {formatMoney(c.alreadyUsed)}，提交后将超支 {formatMoney(c.exceededBy)}
                    </div>
                  ))}
                  {preview.risks.duplicateInvoices.map((d, i) => (
                    <div key={i}>
                      • 发票号 <span className="font-mono font-semibold">{d.invoiceNo}</span> 疑似重复（关联：
                      {d.conflictClaimNos.join(', ')}）
                    </div>
                  ))}
                </div>
              )}

              <div className="p-3.5 rounded-xl bg-brand-50/70 border border-brand-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="text-xs">
                  <div className="font-semibold text-brand-900 mb-1">预计动态审批链路</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-brand-800">
                    {preview.route.map((s, idx) => (
                      <React.Fragment key={s.stepOrder}>
                        <span className="px-2 py-0.5 rounded-md bg-white border border-brand-200">
                          {s.stepOrder}. {s.stepName}
                        </span>
                        {idx < preview.route.length - 1 && <span>→</span>}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <div className="text-xs text-stone-500">
                    报销总额 {formatMoney(totalFormAmount)} · 冲销 {formatMoney(offsetAmount)}
                  </div>
                  <div className="text-base font-bold text-stone-900">
                    预计实付：{formatMoney(netPayPreview)}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t border-stone-100">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm text-stone-600 hover:bg-stone-50"
            >
              取消
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSave(false)}
              className="px-4 py-2 rounded-xl border border-stone-300 bg-white hover:bg-stone-50 text-sm font-medium text-stone-800"
            >
              保存草稿
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => handleSave(true)}
              className="px-5 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold"
            >
              {saving ? '提交中...' : '提交审批'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail ? `${detail.claim.title}` : ''}
        subtitle={detail ? `${detail.claim.claim_no} · ${detail.claim.hotel_name} · ${detail.claim.applicant_name}` : ''}
        maxWidth="max-w-3xl"
      >
        {detail && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-stone-50 border border-stone-200">
              <div className="flex items-center gap-3">
                <StatusBadge status={detail.claim.status} />
                <span className="text-xs text-stone-500">费用月份：{detail.claim.expense_month}</span>
              </div>
              <div className="flex items-center gap-5 tabular-nums text-sm">
                <div>
                  <span className="text-xs text-stone-500 block">报销总额</span>
                  <span className="font-bold text-stone-900">{formatMoney(detail.claim.total_amount)}</span>
                </div>
                <div>
                  <span className="text-xs text-stone-500 block">借款冲销</span>
                  <span className="font-semibold text-sky-700">{formatMoney(detail.claim.offset_amount)}</span>
                </div>
                <div>
                  <span className="text-xs text-stone-500 block">实付金额</span>
                  <span className="font-bold text-brand-700">{formatMoney(detail.claim.net_pay_amount)}</span>
                </div>
              </div>
            </div>

            {detail.claim.risk_summary && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">风控预警提示</div>
                  <div className="mt-0.5">{detail.claim.risk_summary}</div>
                </div>
              </div>
            )}

            {detail.cashAdvance && (
              <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-900">
                关联冲销借款单：<span className="font-mono font-semibold">{detail.cashAdvance.advance_no}</span>（
                {detail.cashAdvance.purpose}，借款总额 {formatMoney(detail.cashAdvance.amount)}）
              </div>
            )}

            {/* Items */}
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-2.5">
                费用明细清单
              </h4>
              <div className="border border-stone-200 rounded-xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-stone-50 text-stone-500 border-b border-stone-200">
                    <tr>
                      <th className="px-3 py-2 text-left">科目 / 日期</th>
                      <th className="px-3 py-2 text-left">说明</th>
                      <th className="px-3 py-2 text-left">发票号 / 附件</th>
                      <th className="px-3 py-2 text-right">金额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {detail.items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-stone-800">{it.category_label}</div>
                          <div className="text-stone-400">{it.expense_date}</div>
                        </td>
                        <td className="px-3 py-2.5 text-stone-700">{it.description}</td>
                        <td className="px-3 py-2.5">
                          {it.invoice_no && (
                            <span
                              className={`font-mono ${
                                it.is_duplicate_invoice ? 'text-rose-600 font-semibold' : 'text-stone-600'
                              }`}
                            >
                              {it.invoice_no}
                              {it.is_duplicate_invoice ? ' (疑似重复)' : ''}
                            </span>
                          )}
                          {it.attachment_url && (
                            <button
                              type="button"
                              onClick={() => setPreviewUrl(it.attachment_url)}
                              className="mt-1 flex items-center gap-1 text-brand-700 hover:underline"
                            >
                              <Eye className="w-3.5 h-3.5" /> 查看发票凭证
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                          {formatMoney(it.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {detail.claim.payment_ref && (
              <div className="p-3 rounded-xl bg-teal-50 border border-teal-200 text-xs text-teal-900">
                财务打款流水号：<span className="font-mono font-semibold">{detail.claim.payment_ref}</span> · 打款时间：
                {detail.claim.paid_at}
              </div>
            )}

            <ApprovalTimeline steps={detail.approvalSteps} logs={detail.approvalLogs} />

            {/* Context Actions */}
            {(detail.permissions.canApprove ||
              detail.permissions.canEdit ||
              detail.permissions.canWithdraw) && (
              <div className="pt-4 border-t border-stone-200 space-y-3">
                {detail.permissions.canApprove && (
                  <>
                    <textarea
                      rows={2}
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="填写审批意见（退回或驳回时必填）..."
                      className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                    />
                    <div className="flex flex-wrap items-center justify-end gap-2.5">
                      <button
                        disabled={acting}
                        onClick={() => handleWorkflowAction('REJECT')}
                        className="px-4 py-2 rounded-xl border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center gap-1.5"
                      >
                        <XCircle className="w-4 h-4" /> 驳回
                      </button>
                      <button
                        disabled={acting}
                        onClick={() => handleWorkflowAction('RETURN')}
                        className="px-4 py-2 rounded-xl border border-orange-200 text-orange-700 hover:bg-orange-50 text-xs font-semibold flex items-center gap-1.5"
                      >
                        <RotateCcw className="w-4 h-4" /> 退回修改
                      </button>
                      <button
                        disabled={acting}
                        onClick={() => handleWorkflowAction('APPROVE')}
                        className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5"
                      >
                        <Check className="w-4 h-4" /> 同意通过
                      </button>
                    </div>
                  </>
                )}

                <div className="flex items-center justify-end gap-2.5">
                  {detail.permissions.canEdit && (
                    <button
                      onClick={() => openEditFromDetail(detail)}
                      className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <FileText className="w-4 h-4" /> 编辑并重新提交
                    </button>
                  )}
                  {detail.permissions.canWithdraw && (
                    <button
                      onClick={() => handleWithdraw(detail.claim.id)}
                      className="px-4 py-2 rounded-xl border border-stone-300 text-stone-700 hover:bg-stone-50 text-xs font-semibold"
                    >
                      撤回至草稿
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Invoice Attachment Preview Modal */}
      <Modal
        open={Boolean(previewUrl)}
        onClose={() => setPreviewUrl(null)}
        title="发票凭证预览"
        maxWidth="max-w-3xl"
      >
        {previewUrl && (
          <div className="flex flex-col items-center gap-3">
            {previewUrl.toLowerCase().endsWith('.pdf') ? (
              <iframe src={previewUrl} title="PDF Preview" className="w-full h-[500px] rounded-xl border" />
            ) : (
              <img
                src={previewUrl}
                alt="发票凭证"
                className="max-h-[520px] rounded-xl border border-stone-200 shadow-sm"
              />
            )}
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-brand-700 hover:underline"
            >
              在新窗口打开原文件
            </a>
          </div>
        )}
      </Modal>
    </div>
  );
}
