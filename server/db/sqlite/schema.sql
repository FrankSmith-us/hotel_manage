-- 悦栖连锁酒店内部日常业务管理系统 - SQLite Local Demo Schema (100% column-compatible with MySQL)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  manager_user_id INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region_id INTEGER NOT NULL REFERENCES regions(id),
  city_id INTEGER,
  district_id INTEGER,
  city TEXT NOT NULL,
  district TEXT,
  address TEXT NOT NULL,
  phone TEXT NOT NULL,
  room_count INTEGER NOT NULL DEFAULT 0,
  is_hq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  opened_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(hotel_id, code)
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'M',
  phone TEXT NOT NULL,
  email TEXT,
  id_card_last4 TEXT NOT NULL DEFAULT '',
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  position_id INTEGER,
  position TEXT NOT NULL,
  education TEXT,
  marital_status TEXT,
  political_status TEXT,
  employment_type TEXT NOT NULL DEFAULT 'FULL_TIME',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  hire_date TEXT NOT NULL,
  probation_end_date TEXT,
  resign_date TEXT,
  contract_end_date TEXT,
  health_cert_no TEXT,
  health_cert_expiry TEXT,
  base_salary REAL NOT NULL DEFAULT 0.00,
  probation_salary_ratio REAL NOT NULL DEFAULT 1.00,
  special_additional_deduction REAL NOT NULL DEFAULT 0.00,
  night_allowance_rate REAL NOT NULL DEFAULT 80.00,
  bank_name TEXT,
  bank_account TEXT,
  emergency_contact TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emp_hotel_status ON employees(hotel_id, status);
CREATE INDEX IF NOT EXISTS idx_emp_health_expiry ON employees(health_cert_expiry);
CREATE INDEX IF NOT EXISTS idx_emp_contract_expiry ON employees(contract_end_date);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id),
  hotel_id INTEGER REFERENCES hotels(id),
  region_id INTEGER REFERENCES regions(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS employee_lifecycle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  event_type TEXT NOT NULL,
  from_hotel_id INTEGER,
  to_hotel_id INTEGER,
  from_position TEXT,
  to_position TEXT,
  effective_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  operator_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_emp ON employee_lifecycle_events(employee_id);

CREATE TABLE IF NOT EXISTS shift_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  home_hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  assigned_hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  shift_date TEXT NOT NULL,
  shift_type TEXT NOT NULL,
  is_cross_store INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, shift_date)
);
CREATE INDEX IF NOT EXISTS idx_shift_hotel_date ON shift_schedules(assigned_hotel_id, shift_date);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL DEFAULT 0.00,
  hours REAL NOT NULL DEFAULT 0.00,
  reason TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  approver_id INTEGER,
  approval_remark TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leave_hotel_status ON leave_requests(hotel_id, status);

CREATE TABLE IF NOT EXISTS payroll_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  `year_month` TEXT NOT NULL,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  base_salary REAL NOT NULL DEFAULT 0.00,
  prorated_days REAL NOT NULL DEFAULT 0.00,
  total_month_days INTEGER NOT NULL DEFAULT 30,
  night_shifts INTEGER NOT NULL DEFAULT 0,
  night_allowance REAL NOT NULL DEFAULT 0.00,
  overtime_hours REAL NOT NULL DEFAULT 0.00,
  overtime_pay REAL NOT NULL DEFAULT 0.00,
  leave_deduction_days REAL NOT NULL DEFAULT 0.00,
  leave_deduction REAL NOT NULL DEFAULT 0.00,
  performance_bonus REAL NOT NULL DEFAULT 0.00,
  other_allowance REAL NOT NULL DEFAULT 0.00,
  city_ss_base REAL NOT NULL DEFAULT 0.00,
  social_security REAL NOT NULL DEFAULT 0.00,
  special_deduction REAL NOT NULL DEFAULT 0.00,
  taxable_income REAL NOT NULL DEFAULT 0.00,
  ytd_taxable_income REAL NOT NULL DEFAULT 0.00,
  ytd_tax_paid REAL NOT NULL DEFAULT 0.00,
  income_tax REAL NOT NULL DEFAULT 0.00,
  advance_deduction REAL NOT NULL DEFAULT 0.00,
  other_deduction REAL NOT NULL DEFAULT 0.00,
  gross_pay REAL NOT NULL DEFAULT 0.00,
  net_pay REAL NOT NULL DEFAULT 0.00,
  is_resigned_settlement INTEGER NOT NULL DEFAULT 0,
  batch_id INTEGER,
  payslip_viewed_at TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  confirmed_by INTEGER,
  confirmed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(`year_month`, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_payroll_hotel_month ON payroll_records(hotel_id, `year_month`);

CREATE TABLE IF NOT EXISTS headcount_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  position TEXT NOT NULL,
  headcount INTEGER NOT NULL DEFAULT 1,
  urgency TEXT NOT NULL DEFAULT 'NORMAL',
  salary_range TEXT NOT NULL,
  reason TEXT NOT NULL,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  headcount_request_id INTEGER REFERENCES headcount_requests(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  position TEXT NOT NULL,
  expected_salary REAL NOT NULL DEFAULT 0.00,
  stage TEXT NOT NULL DEFAULT 'SCREENING',
  interview_notes TEXT,
  hired_employee_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS store_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  `year_month` TEXT NOT NULL,
  category TEXT NOT NULL,
  budget_amount REAL NOT NULL DEFAULT 0.00,
  updated_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(hotel_id, `year_month`, category)
);

CREATE TABLE IF NOT EXISTS cash_advances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_no TEXT NOT NULL UNIQUE,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  employee_id INTEGER,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  advance_type TEXT NOT NULL DEFAULT 'PETTY_CASH',
  amount REAL NOT NULL,
  offset_amount REAL NOT NULL DEFAULT 0.00,
  repaid_amount REAL NOT NULL DEFAULT 0.00,
  purpose TEXT NOT NULL,
  expected_settle_date TEXT NOT NULL,
  payee_name TEXT,
  payee_bank TEXT,
  payee_account TEXT,
  urgency TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  payment_ref TEXT,
  disbursed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adv_hotel_status ON cash_advances(hotel_id, status);

CREATE TABLE IF NOT EXISTS reimbursements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_no TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  employee_id INTEGER,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  department_id INTEGER,
  expense_month TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0.00,
  cash_advance_id INTEGER REFERENCES cash_advances(id),
  offset_amount REAL NOT NULL DEFAULT 0.00,
  net_pay_amount REAL NOT NULL DEFAULT 0.00,
  urgency TEXT NOT NULL DEFAULT 'NORMAL',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER NOT NULL DEFAULT 0,
  risk_flags TEXT NOT NULL DEFAULT '',
  risk_summary TEXT,
  returned_to_step INTEGER,
  returned_to_user_id INTEGER,
  returned_to_role TEXT,
  returned_from_step INTEGER,
  return_reason TEXT,
  remarks TEXT,
  payment_type TEXT NOT NULL DEFAULT 'PERSONAL',
  payee_name TEXT NOT NULL,
  payee_bank TEXT,
  payee_account TEXT,
  payment_channel TEXT,
  payment_ref TEXT,
  payment_fail_reason TEXT,
  payment_attempts INTEGER NOT NULL DEFAULT 0,
  paid_by INTEGER,
  paid_at TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reimb_hotel_month ON reimbursements(hotel_id, expense_month);
CREATE INDEX IF NOT EXISTS idx_reimb_status ON reimbursements(status);

CREATE TABLE IF NOT EXISTS reimbursement_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reimbursement_id INTEGER NOT NULL REFERENCES reimbursements(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  expense_date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  invoice_no TEXT,
  attachment_url TEXT,
  attachment_name TEXT,
  is_duplicate_invoice INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ritem_claim ON reimbursement_items(reimbursement_id);
CREATE INDEX IF NOT EXISTS idx_ritem_invoice ON reimbursement_items(invoice_no);

CREATE TABLE IF NOT EXISTS approval_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type TEXT NOT NULL,
  biz_id INTEGER NOT NULL,
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  approver_user_id INTEGER,
  status TEXT NOT NULL DEFAULT 'WAITING',
  acted_by INTEGER,
  acted_at TEXT,
  comment TEXT,
  delegated_from_user_id INTEGER,
  skip_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(biz_type, biz_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_steps_biz ON approval_steps(biz_type, biz_id, step_order);

CREATE TABLE IF NOT EXISTS approval_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegator_user_id INTEGER NOT NULL REFERENCES users(id),
  delegate_user_id INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  biz_types TEXT NOT NULL DEFAULT 'ALL',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_delegate ON approval_delegations(delegate_user_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS approval_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_type TEXT NOT NULL,
  biz_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_biz ON approval_logs(biz_type, biz_id, created_at);

CREATE TABLE IF NOT EXISTS payee_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_type TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  hotel_id INTEGER,
  last_paid_at TEXT NOT NULL,
  paid_count INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(payment_type, account_number)
);
CREATE INDEX IF NOT EXISTS idx_payee_type ON payee_accounts(payment_type);

CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id INTEGER NOT NULL REFERENCES regions(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cities_region ON cities(region_id);

CREATE TABLE IF NOT EXISTS districts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER NOT NULL REFERENCES cities(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_districts_city ON districts(city_id);

CREATE TABLE IF NOT EXISTS dept_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_level TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_level, code)
);

CREATE TABLE IF NOT EXISTS job_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_level TEXT NOT NULL,
  dept_template_id INTEGER NOT NULL REFERENCES dept_templates(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(org_level, dept_template_id, code)
);
CREATE INDEX IF NOT EXISTS idx_pos_dept_tpl ON job_positions(dept_template_id);

CREATE TABLE IF NOT EXISTS master_dict_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_type TEXT NOT NULL,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(dict_type, code)
);
CREATE INDEX IF NOT EXISTS idx_dict_type ON master_dict_items(dict_type);

CREATE TABLE IF NOT EXISTS master_data_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_label TEXT NOT NULL,
  action TEXT NOT NULL,
  before_data TEXT,
  after_data TEXT,
  operator_id INTEGER NOT NULL,
  operator_name TEXT NOT NULL,
  operator_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_md_audit_entity ON master_data_audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_md_audit_created ON master_data_audit_logs(created_at);

CREATE TABLE IF NOT EXISTS master_data_sequences (
  seq_key TEXT PRIMARY KEY,
  last_val INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  candidate_name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'M',
  phone TEXT NOT NULL,
  email TEXT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  position_id INTEGER,
  position TEXT NOT NULL,
  education TEXT,
  employment_type TEXT NOT NULL DEFAULT 'FULL_TIME',
  marital_status TEXT,
  political_status TEXT,
  planned_hire_date TEXT NOT NULL,
  base_salary REAL NOT NULL DEFAULT 0,
  night_allowance_rate REAL NOT NULL DEFAULT 80,
  health_cert_expiry TEXT,
  contract_end_date TEXT,
  create_user_account INTEGER NOT NULL DEFAULT 1,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  checklist_json TEXT,
  employee_id INTEGER,
  remarks TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_onboard_hotel ON onboarding_requests(hotel_id);
CREATE INDEX IF NOT EXISTS idx_onboard_status ON onboarding_requests(status);

CREATE TABLE IF NOT EXISTS offboarding_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  resign_reason_code TEXT NOT NULL,
  resign_reason_detail TEXT NOT NULL,
  last_working_date TEXT NOT NULL,
  handover_to_employee_id INTEGER,
  handover_notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  checklist_json TEXT,
  archive_id INTEGER,
  effective_executed_at TEXT,
  settlement_status TEXT NOT NULL DEFAULT 'PENDING',
  unsettled_advance_amount REAL NOT NULL DEFAULT 0.00,
  pending_reimbursement_count INTEGER NOT NULL DEFAULT 0,
  handover_to_user_id INTEGER,
  scheduled_execute INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offboard_emp ON offboarding_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_offboard_status ON offboarding_requests(status);

CREATE TABLE IF NOT EXISTS offboarding_clearance_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offboarding_id INTEGER NOT NULL REFERENCES offboarding_requests(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_label TEXT NOT NULL,
  department_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  remark TEXT,
  cleared_by INTEGER,
  cleared_by_name TEXT,
  cleared_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(offboarding_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_off_clear_req ON offboarding_clearance_items(offboarding_id);

CREATE TABLE IF NOT EXISTS employee_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id),
  emp_no TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  hotel_id INTEGER NOT NULL,
  hotel_name TEXT NOT NULL,
  department_name TEXT NOT NULL,
  position TEXT NOT NULL,
  hire_date TEXT NOT NULL,
  resign_date TEXT NOT NULL,
  resign_reason TEXT NOT NULL,
  offboarding_request_id INTEGER,
  employee_snapshot_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  records_json TEXT NOT NULL,
  archived_by INTEGER NOT NULL,
  archived_by_name TEXT NOT NULL,
  archived_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_archives_hotel ON employee_archives(hotel_id);

CREATE TABLE IF NOT EXISTS budget_change_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  `year_month` TEXT NOT NULL,
  category TEXT NOT NULL,
  old_amount REAL NOT NULL DEFAULT 0,
  new_amount REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_by_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_logs_hotel_ym ON budget_change_logs(hotel_id, `year_month`);

CREATE TABLE IF NOT EXISTS cash_advance_repayments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  advance_id INTEGER NOT NULL REFERENCES cash_advances(id),
  repayment_no TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  repayment_method TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
  payment_ref TEXT,
  remark TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_by_name TEXT NOT NULL,
  repaid_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adv_repayments_adv ON cash_advance_repayments(advance_id);

CREATE TABLE IF NOT EXISTS city_social_security_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL UNIQUE,
  effective_year INTEGER NOT NULL DEFAULT 2026,
  ss_base_min REAL NOT NULL DEFAULT 0.00,
  ss_base_max REAL NOT NULL DEFAULT 999999.00,
  pension_rate REAL NOT NULL DEFAULT 0.08,
  medical_rate REAL NOT NULL DEFAULT 0.02,
  unemployment_rate REAL NOT NULL DEFAULT 0.005,
  housing_fund_rate REAL NOT NULL DEFAULT 0.07,
  total_personal_rate REAL NOT NULL DEFAULT 0.175,
  updated_by INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,
  `year_month` TEXT NOT NULL,
  hotel_id INTEGER,
  total_employees INTEGER NOT NULL DEFAULT 0,
  total_gross REAL NOT NULL DEFAULT 0.00,
  total_net REAL NOT NULL DEFAULT 0.00,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  paid_by INTEGER,
  payment_ref TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payroll_batches_ym ON payroll_batches(`year_month`, status);

CREATE TABLE IF NOT EXISTS employee_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  change_type TEXT NOT NULL,
  from_hotel_id INTEGER NOT NULL,
  to_hotel_id INTEGER NOT NULL,
  from_department_id INTEGER NOT NULL,
  to_department_id INTEGER NOT NULL,
  from_position TEXT NOT NULL,
  to_position TEXT NOT NULL,
  from_salary REAL NOT NULL DEFAULT 0.00,
  to_salary REAL NOT NULL DEFAULT 0.00,
  effective_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  applicant_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  executed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emp_change_status ON employee_change_requests(status, effective_date);

CREATE TABLE IF NOT EXISTS shift_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL DEFAULT 0,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  work_hours REAL NOT NULL DEFAULT 8.0,
  is_night INTEGER NOT NULL DEFAULT 0,
  allowance_amount REAL NOT NULL DEFAULT 0.00,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(hotel_id, code)
);

CREATE TABLE IF NOT EXISTS schedule_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  week_start TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  published_by INTEGER,
  published_at TEXT,
  locked_by INTEGER,
  locked_at TEXT,
  UNIQUE(hotel_id, week_start)
);

CREATE TABLE IF NOT EXISTS shift_swap_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  requester_emp_id INTEGER NOT NULL REFERENCES employees(id),
  target_emp_id INTEGER NOT NULL REFERENCES employees(id),
  requester_shift_date TEXT NOT NULL,
  target_shift_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_TARGET',
  current_step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shift_swap_hotel ON shift_swap_requests(hotel_id, status);

CREATE TABLE IF NOT EXISTS leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  year INTEGER NOT NULL,
  leave_type TEXT NOT NULL,
  total_days REAL NOT NULL DEFAULT 0.0,
  used_days REAL NOT NULL DEFAULT 0.0,
  pending_days REAL NOT NULL DEFAULT 0.0,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, year, leave_type)
);

CREATE TABLE IF NOT EXISTS holiday_calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  day_type TEXT NOT NULL DEFAULT 'HOLIDAY',
  year INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  attendance_date TEXT NOT NULL,
  scheduled_shift TEXT,
  check_in_time TEXT,
  check_out_time TEXT,
  work_hours REAL NOT NULL DEFAULT 8.0,
  is_night_shift INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'NORMAL',
  is_locked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'CSV_IMPORT',
  remark TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id, attendance_date)
);
CREATE INDEX IF NOT EXISTS idx_att_hotel_date ON attendance_records(hotel_id, attendance_date);

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  attendance_date TEXT NOT NULL,
  check_type TEXT NOT NULL DEFAULT 'CHECK_IN',
  corrected_time TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_no TEXT NOT NULL UNIQUE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  hotel_id INTEGER NOT NULL REFERENCES hotels(id),
  overtime_date TEXT NOT NULL,
  day_type TEXT NOT NULL DEFAULT 'WORKDAY',
  hours REAL NOT NULL,
  comp_mode TEXT NOT NULL DEFAULT 'PAY',
  multiplier REAL NOT NULL DEFAULT 1.5,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INTEGER NOT NULL DEFAULT 1,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ot_emp_date ON overtime_requests(employee_id, overtime_date);
