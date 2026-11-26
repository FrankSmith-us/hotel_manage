export function formatMoney(val: number | string | null | undefined): string {
  const num = Number(val || 0);
  return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function currentYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getMondayStr(offsetWeeks = 0): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day) + offsetWeeks * 7;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const EXPENSE_CATEGORIES = [
  { value: 'LINEN_SUPPLIES', label: '客房布草与客耗品' },
  { value: 'MAINTENANCE', label: '工程维修与维保' },
  { value: 'FB_PROCUREMENT', label: '餐饮食材采购' },
  { value: 'UTILITIES', label: '水电燃气与物业' },
  { value: 'MARKETING', label: '门店营销与OTA推广' },
  { value: 'TRAVEL_TRAINING', label: '差旅交通与培训' },
  { value: 'OTHER', label: '其他运营杂费' },
] as const;

export const EXPENSE_CATEGORY_MAP: Record<string, string> = Object.fromEntries(
  EXPENSE_CATEGORIES.map((c) => [c.value, c.label])
);

export const SHIFT_OPTIONS = [
  { value: 'MORNING', label: '早班', short: '早', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'AFTERNOON', label: '中班', short: '中', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'EVENING', label: '晚班', short: '晚', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  { value: 'NIGHT', label: '夜班', short: '夜', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { value: 'OFF', label: '休息', short: '休', color: 'bg-stone-100 text-stone-500 border-stone-200' },
] as const;

export const LEAVE_TYPE_MAP: Record<string, string> = {
  ANNUAL: '年假',
  SICK: '病假',
  PERSONAL: '事假',
  COMP_OFF: '调休',
  OVERTIME: '加班申请',
};

export const ACTION_LABEL_MAP: Record<string, string> = {
  APPROVE: '我已同意',
  RETURN: '我已退回修改',
  REJECT: '我已驳回',
  PAY: '我已打款',
  DISBURSE: '我已放款',
};

export const STATUS_META: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: '草稿', cls: 'bg-stone-100 text-stone-600 border-stone-200' },
  PENDING_APPROVAL: { label: '审批中', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  RETURNED: { label: '已退回修改', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  APPROVED: { label: '已通过(待执行)', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  REJECTED: { label: '已驳回', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  PAID: { label: '已打款核销', cls: 'bg-teal-50 text-teal-700 border-teal-200' },
  DISBURSED: { label: '已放款(待冲销)', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  SETTLED: { label: '已全额冲销', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CANCELLED: { label: '已撤销', cls: 'bg-stone-100 text-stone-500 border-stone-200' },
  CONFIRMED: { label: '已确认锁账', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ACTIVE: { label: '在职', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  PROBATION: { label: '试用期', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  RESIGNED: { label: '已离职', cls: 'bg-stone-100 text-stone-500 border-stone-200' },
  SCREENING: { label: '初筛', cls: 'bg-stone-100 text-stone-700 border-stone-200' },
  INTERVIEW: { label: '面试中', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  OFFERED: { label: '已发Offer', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  HIRED: { label: '已入职建档', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CONTRACTED: { label: '签约', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  RENOVATING: { label: '装修', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  SOFT_OPENING: { label: '试营业', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  OPEN: { label: '开业', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  SUSPENDED: { label: '停业整顿', cls: 'bg-orange-50 text-orange-700 border-orange-200' },
  CLOSED: { label: '关闭', cls: 'bg-stone-200 text-stone-600 border-stone-300' },
};
