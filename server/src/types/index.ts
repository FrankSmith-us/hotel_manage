export type UserRole =
  | 'HQ_ADMIN'
  | 'CHAIRMAN'
  | 'GENERAL_MANAGER'
  | 'HR_MANAGER'
  | 'FINANCE'
  | 'REGIONAL_MANAGER'
  | 'STORE_MANAGER'
  | 'STAFF';

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  employee_id: number | null;
  hotel_id: number | null;
  region_id: number | null;
  hotel_name?: string | null;
  hotel_code?: string | null;
  region_name?: string | null;
  must_change_password?: boolean;
}

export type BizType =
  | 'REIMBURSEMENT'
  | 'LEAVE'
  | 'HEADCOUNT'
  | 'CASH_ADVANCE'
  | 'ONBOARDING'
  | 'OFFBOARDING'
  | 'PAYROLL_BATCH'
  | 'EMPLOYEE_CHANGE'
  | 'SHIFT_SWAP'
  | 'ATTENDANCE_CORRECTION'
  | 'OVERTIME'
  | 'CONTRACT_RENEWAL';
export type AuditBizType = BizType | 'EMPLOYEE' | 'REGION' | 'BUDGET' | 'PAYROLL' | 'USER';

export type ExpenseCategory =
  | 'LINEN_SUPPLIES'
  | 'MAINTENANCE'
  | 'FB_PROCUREMENT'
  | 'UTILITIES'
  | 'MARKETING'
  | 'TRAVEL_TRAINING'
  | 'OTHER';

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  LINEN_SUPPLIES: '客房布草与客耗品',
  MAINTENANCE: '工程维修与维保',
  FB_PROCUREMENT: '餐饮食材采购',
  UTILITIES: '水电燃气与物业',
  MARKETING: '门店营销与OTA推广',
  TRAVEL_TRAINING: '差旅交通与培训',
  OTHER: '其他运营杂费',
};

export const ROLE_LABELS: Record<UserRole, string> = {
  HQ_ADMIN: '集团系统管理员',
  CHAIRMAN: '董事长',
  GENERAL_MANAGER: '集团总经理',
  HR_MANAGER: '集团HR总监',
  FINANCE: '集团财务经理',
  REGIONAL_MANAGER: '区域经理',
  STORE_MANAGER: '门店店长',
  STAFF: '门店员工',
};

export const SHIFT_LABELS: Record<string, string> = {
  MORNING: '早班',
  AFTERNOON: '中班',
  EVENING: '晚班',
  NIGHT: '夜班',
  OFF: '休息',
};
