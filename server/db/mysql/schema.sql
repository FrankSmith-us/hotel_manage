-- 悦栖连锁酒店内部日常业务管理系统 - MySQL 8.0 Schema
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS regions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  manager_user_id BIGINT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hotels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  region_id BIGINT NOT NULL,
  city_id BIGINT NULL,
  district_id BIGINT NULL,
  city VARCHAR(64) NOT NULL,
  district VARCHAR(64) NULL,
  address VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  room_count INT NOT NULL DEFAULT 0,
  is_hq TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'OPEN',
  opened_at VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_hotels_region FOREIGN KEY (region_id) REFERENCES regions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS departments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(80) NOT NULL,
  category VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_dept_hotel_code (hotel_id, code),
  CONSTRAINT fk_departments_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  emp_no VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL,
  gender VARCHAR(12) NOT NULL DEFAULT 'M',
  phone VARCHAR(32) NOT NULL,
  email VARCHAR(120) NULL,
  id_card_last4 VARCHAR(8) NOT NULL DEFAULT '',
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  position_id BIGINT NULL,
  position VARCHAR(80) NOT NULL,
  education VARCHAR(32) NULL,
  marital_status VARCHAR(24) NULL,
  political_status VARCHAR(24) NULL,
  employment_type VARCHAR(24) NOT NULL DEFAULT 'FULL_TIME',
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  hire_date VARCHAR(16) NOT NULL,
  probation_end_date VARCHAR(16) NULL,
  resign_date VARCHAR(16) NULL,
  contract_end_date VARCHAR(16) NULL,
  health_cert_no VARCHAR(64) NULL,
  health_cert_expiry VARCHAR(16) NULL,
  base_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  probation_salary_ratio DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  special_additional_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  night_allowance_rate DECIMAL(12,2) NOT NULL DEFAULT 80.00,
  bank_name VARCHAR(80) NULL,
  bank_account VARCHAR(64) NULL,
  emergency_contact VARCHAR(100) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_emp_hotel_status (hotel_id, status),
  INDEX idx_emp_health_expiry (health_cert_expiry),
  INDEX idx_emp_contract_expiry (contract_end_date),
  CONSTRAINT fk_employees_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_employees_dept FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  role VARCHAR(32) NOT NULL,
  employee_id BIGINT NULL,
  hotel_id BIGINT NULL,
  region_id BIGINT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  password_changed_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_users_role (role),
  CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_users_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_users_region FOREIGN KEY (region_id) REFERENCES regions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_lifecycle_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_hotel_id BIGINT NULL,
  to_hotel_id BIGINT NULL,
  from_position VARCHAR(80) NULL,
  to_position VARCHAR(80) NULL,
  effective_date VARCHAR(16) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  operator_id BIGINT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_lifecycle_emp (employee_id),
  CONSTRAINT fk_lifecycle_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shift_schedules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT NOT NULL,
  home_hotel_id BIGINT NOT NULL,
  assigned_hotel_id BIGINT NOT NULL,
  shift_date VARCHAR(16) NOT NULL,
  shift_type VARCHAR(24) NOT NULL,
  is_cross_store TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(255) NULL,
  created_by BIGINT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_shift_emp_date (employee_id, shift_date),
  INDEX idx_shift_hotel_date (assigned_hotel_id, shift_date),
  CONSTRAINT fk_shift_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_shift_home_hotel FOREIGN KEY (home_hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_shift_assigned_hotel FOREIGN KEY (assigned_hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  leave_type VARCHAR(24) NOT NULL,
  start_date VARCHAR(16) NOT NULL,
  end_date VARCHAR(16) NOT NULL,
  days DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  hours DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  reason VARCHAR(255) NOT NULL,
  urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  approver_id BIGINT NULL,
  approval_remark VARCHAR(255) NULL,
  approved_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_leave_hotel_status (hotel_id, status),
  CONSTRAINT fk_leave_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_leave_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_records (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  `year_month` VARCHAR(10) NOT NULL,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  base_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  prorated_days DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  total_month_days INT NOT NULL DEFAULT 30,
  night_shifts INT NOT NULL DEFAULT 0,
  night_allowance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  overtime_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  leave_deduction_days DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  leave_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  performance_bonus DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  other_allowance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  city_ss_base DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  social_security DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  special_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  taxable_income DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ytd_taxable_income DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ytd_tax_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  income_tax DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  advance_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  other_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  net_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_resigned_settlement TINYINT(1) NOT NULL DEFAULT 0,
  batch_id BIGINT NULL,
  payslip_viewed_at VARCHAR(32) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  confirmed_by BIGINT NULL,
  confirmed_at VARCHAR(32) NULL,
  notes VARCHAR(255) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_payroll_month_emp (`year_month`, employee_id),
  INDEX idx_payroll_hotel_month (hotel_id, `year_month`),
  CONSTRAINT fk_payroll_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_payroll_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS headcount_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  position VARCHAR(80) NOT NULL,
  headcount INT NOT NULL DEFAULT 1,
  urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  salary_range VARCHAR(64) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  applicant_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_hc_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_hc_dept FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_hc_applicant FOREIGN KEY (applicant_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS candidates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  headcount_request_id BIGINT NULL,
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  name VARCHAR(64) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  position VARCHAR(80) NOT NULL,
  expected_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  stage VARCHAR(24) NOT NULL DEFAULT 'SCREENING',
  interview_notes TEXT NULL,
  hired_employee_id BIGINT NULL,
  created_by BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_cand_hc FOREIGN KEY (headcount_request_id) REFERENCES headcount_requests(id),
  CONSTRAINT fk_cand_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_cand_dept FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS store_budgets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  `year_month` VARCHAR(10) NOT NULL,
  category VARCHAR(32) NOT NULL,
  budget_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  updated_by BIGINT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_budget_hotel_month_cat (hotel_id, `year_month`, category),
  CONSTRAINT fk_budget_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_advances (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  advance_no VARCHAR(32) NOT NULL UNIQUE,
  applicant_id BIGINT NOT NULL,
  employee_id BIGINT NULL,
  hotel_id BIGINT NOT NULL,
  advance_type VARCHAR(24) NOT NULL DEFAULT 'PETTY_CASH',
  amount DECIMAL(12,2) NOT NULL,
  offset_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  repaid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  purpose VARCHAR(255) NOT NULL,
  expected_settle_date VARCHAR(16) NOT NULL,
  payee_name VARCHAR(80) NULL,
  payee_bank VARCHAR(120) NULL,
  payee_account VARCHAR(64) NULL,
  urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  payment_ref VARCHAR(64) NULL,
  disbursed_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_adv_hotel_status (hotel_id, status),
  CONSTRAINT fk_adv_applicant FOREIGN KEY (applicant_id) REFERENCES users(id),
  CONSTRAINT fk_adv_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reimbursements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  claim_no VARCHAR(32) NOT NULL UNIQUE,
  title VARCHAR(120) NOT NULL,
  applicant_id BIGINT NOT NULL,
  employee_id BIGINT NULL,
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NULL,
  expense_month VARCHAR(10) NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  cash_advance_id BIGINT NULL,
  offset_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  net_pay_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  urgency VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  current_step INT NOT NULL DEFAULT 0,
  total_steps INT NOT NULL DEFAULT 0,
  risk_flags VARCHAR(120) NOT NULL DEFAULT '',
  risk_summary VARCHAR(500) NULL,
  returned_to_step INT NULL,
  returned_to_user_id BIGINT NULL,
  returned_to_role VARCHAR(32) NULL,
  returned_from_step INT NULL,
  return_reason VARCHAR(500) NULL,
  remarks VARCHAR(500) NULL,
  payment_type VARCHAR(24) NOT NULL DEFAULT 'PERSONAL',
  payee_name VARCHAR(80) NOT NULL,
  payee_bank VARCHAR(80) NULL,
  payee_account VARCHAR(64) NULL,
  payment_channel VARCHAR(32) NULL,
  payment_ref VARCHAR(64) NULL,
  payment_fail_reason VARCHAR(255) NULL,
  payment_attempts INT NOT NULL DEFAULT 0,
  paid_by BIGINT NULL,
  paid_at VARCHAR(32) NULL,
  submitted_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_reimb_hotel_month (hotel_id, expense_month),
  INDEX idx_reimb_status (status),
  CONSTRAINT fk_reimb_applicant FOREIGN KEY (applicant_id) REFERENCES users(id),
  CONSTRAINT fk_reimb_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_reimb_advance FOREIGN KEY (cash_advance_id) REFERENCES cash_advances(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reimbursement_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  reimbursement_id BIGINT NOT NULL,
  category VARCHAR(32) NOT NULL,
  expense_date VARCHAR(16) NOT NULL,
  description VARCHAR(255) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  invoice_no VARCHAR(64) NULL,
  attachment_url VARCHAR(255) NULL,
  attachment_name VARCHAR(120) NULL,
  is_duplicate_invoice TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_ritem_claim (reimbursement_id),
  INDEX idx_ritem_invoice (invoice_no),
  CONSTRAINT fk_ritem_claim FOREIGN KEY (reimbursement_id) REFERENCES reimbursements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_steps (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  biz_type VARCHAR(32) NOT NULL,
  biz_id BIGINT NOT NULL,
  step_order INT NOT NULL,
  step_name VARCHAR(64) NOT NULL,
  approver_role VARCHAR(32) NOT NULL,
  approver_user_id BIGINT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'WAITING',
  acted_by BIGINT NULL,
  acted_at VARCHAR(32) NULL,
  comment VARCHAR(255) NULL,
  delegated_from_user_id BIGINT NULL,
  skip_reason VARCHAR(255) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_steps_biz_order (biz_type, biz_id, step_order),
  INDEX idx_steps_biz (biz_type, biz_id, step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_delegations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  delegator_user_id BIGINT NOT NULL,
  delegate_user_id BIGINT NOT NULL,
  start_date VARCHAR(16) NOT NULL,
  end_date VARCHAR(16) NOT NULL,
  biz_types VARCHAR(120) NOT NULL DEFAULT 'ALL',
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_delegation_delegate (delegate_user_id, start_date, end_date),
  CONSTRAINT fk_delegation_delegator FOREIGN KEY (delegator_user_id) REFERENCES users(id),
  CONSTRAINT fk_delegation_delegate FOREIGN KEY (delegate_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  biz_type VARCHAR(32) NOT NULL,
  biz_id BIGINT NOT NULL,
  action VARCHAR(32) NOT NULL,
  actor_id BIGINT NOT NULL,
  actor_name VARCHAR(80) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  comment VARCHAR(500) NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_logs_biz (biz_type, biz_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payee_accounts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payment_type VARCHAR(24) NOT NULL,
  account_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(64) NOT NULL,
  bank_name VARCHAR(120) NOT NULL,
  hotel_id BIGINT NULL,
  last_paid_at VARCHAR(32) NOT NULL,
  paid_count INT NOT NULL DEFAULT 1,
  created_by BIGINT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_payee_type_acc (payment_type, account_number),
  INDEX idx_payee_type (payment_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  region_id BIGINT NOT NULL,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_cities_region (region_id),
  CONSTRAINT fk_cities_region FOREIGN KEY (region_id) REFERENCES regions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS districts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  city_id BIGINT NOT NULL,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(64) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_districts_city (city_id),
  CONSTRAINT fk_districts_city FOREIGN KEY (city_id) REFERENCES cities(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS dept_templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_level VARCHAR(16) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(80) NOT NULL,
  category VARCHAR(32) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_dept_tpl_level_code (org_level, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_positions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  org_level VARCHAR(16) NOT NULL,
  dept_template_id BIGINT NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_pos_level_dept_code (org_level, dept_template_id, code),
  INDEX idx_pos_dept_tpl (dept_template_id),
  CONSTRAINT fk_pos_dept_tpl FOREIGN KEY (dept_template_id) REFERENCES dept_templates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_dict_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dict_type VARCHAR(40) NOT NULL,
  code VARCHAR(40) NOT NULL,
  label VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  extra_json VARCHAR(500) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_dict_type_code (dict_type, code),
  INDEX idx_dict_type (dict_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_data_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(40) NOT NULL,
  entity_id BIGINT NOT NULL,
  entity_label VARCHAR(120) NOT NULL,
  action VARCHAR(24) NOT NULL,
  before_data TEXT NULL,
  after_data TEXT NULL,
  operator_id BIGINT NOT NULL,
  operator_name VARCHAR(80) NOT NULL,
  operator_role VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_md_audit_entity (entity_type, entity_id),
  INDEX idx_md_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_data_sequences (
  seq_key VARCHAR(80) PRIMARY KEY,
  last_val INT NOT NULL DEFAULT 0,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS onboarding_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  candidate_name VARCHAR(80) NOT NULL,
  gender VARCHAR(12) NOT NULL DEFAULT 'M',
  phone VARCHAR(24) NOT NULL,
  email VARCHAR(120) NULL,
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  position_id BIGINT NULL,
  position VARCHAR(80) NOT NULL,
  education VARCHAR(32) NULL,
  employment_type VARCHAR(24) NOT NULL DEFAULT 'FULL_TIME',
  marital_status VARCHAR(24) NULL,
  political_status VARCHAR(24) NULL,
  planned_hire_date VARCHAR(16) NOT NULL,
  base_salary DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  night_allowance_rate DECIMAL(10, 2) NOT NULL DEFAULT 80.00,
  health_cert_expiry VARCHAR(16) NULL,
  contract_end_date VARCHAR(16) NULL,
  create_user_account TINYINT(1) NOT NULL DEFAULT 1,
  applicant_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  checklist_json TEXT NULL,
  employee_id BIGINT NULL,
  remarks VARCHAR(500) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_onboard_hotel (hotel_id),
  INDEX idx_onboard_status (status),
  CONSTRAINT fk_onboard_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_onboard_dept FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_onboard_app FOREIGN KEY (applicant_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offboarding_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  applicant_id BIGINT NOT NULL,
  resign_reason_code VARCHAR(40) NOT NULL,
  resign_reason_detail VARCHAR(500) NOT NULL,
  last_working_date VARCHAR(16) NOT NULL,
  handover_to_employee_id BIGINT NULL,
  handover_notes VARCHAR(500) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  checklist_json TEXT NULL,
  archive_id BIGINT NULL,
  effective_executed_at VARCHAR(32) NULL,
  settlement_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  unsettled_advance_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  pending_reimbursement_count INT NOT NULL DEFAULT 0,
  handover_to_user_id BIGINT NULL,
  scheduled_execute TINYINT(1) NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_offboard_emp (employee_id),
  INDEX idx_offboard_status (status),
  CONSTRAINT fk_offboard_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_offboard_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_offboard_app FOREIGN KEY (applicant_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS offboarding_clearance_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  offboarding_id BIGINT NOT NULL,
  item_key VARCHAR(40) NOT NULL,
  item_label VARCHAR(120) NOT NULL,
  department_role VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  remark VARCHAR(255) NULL,
  cleared_by BIGINT NULL,
  cleared_by_name VARCHAR(80) NULL,
  cleared_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_off_clear_item (offboarding_id, item_key),
  INDEX idx_off_clear_req (offboarding_id),
  CONSTRAINT fk_off_clear_req FOREIGN KEY (offboarding_id) REFERENCES offboarding_requests(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_archives (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT NOT NULL UNIQUE,
  emp_no VARCHAR(32) NOT NULL,
  employee_name VARCHAR(80) NOT NULL,
  hotel_id BIGINT NOT NULL,
  hotel_name VARCHAR(120) NOT NULL,
  department_name VARCHAR(80) NOT NULL,
  position VARCHAR(80) NOT NULL,
  hire_date VARCHAR(16) NOT NULL,
  resign_date VARCHAR(16) NOT NULL,
  resign_reason VARCHAR(500) NOT NULL,
  offboarding_request_id BIGINT NULL,
  employee_snapshot_json LONGTEXT NOT NULL,
  summary_json TEXT NOT NULL,
  records_json LONGTEXT NOT NULL,
  archived_by BIGINT NOT NULL,
  archived_by_name VARCHAR(80) NOT NULL,
  archived_at VARCHAR(32) NOT NULL,
  INDEX idx_archives_hotel (hotel_id),
  CONSTRAINT fk_archives_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS budget_change_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  `year_month` VARCHAR(10) NOT NULL,
  category VARCHAR(32) NOT NULL,
  old_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  new_amount DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  reason VARCHAR(255) NOT NULL,
  changed_by BIGINT NOT NULL,
  changed_by_name VARCHAR(80) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_budget_logs_hotel_ym (hotel_id, `year_month`),
  CONSTRAINT fk_budget_logs_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_budget_logs_user FOREIGN KEY (changed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cash_advance_repayments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  advance_id BIGINT NOT NULL,
  repayment_no VARCHAR(32) NOT NULL UNIQUE,
  amount DECIMAL(12, 2) NOT NULL,
  repayment_method VARCHAR(32) NOT NULL DEFAULT 'BANK_TRANSFER',
  payment_ref VARCHAR(64) NULL,
  remark VARCHAR(255) NULL,
  recorded_by BIGINT NOT NULL,
  recorded_by_name VARCHAR(80) NOT NULL,
  repaid_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_adv_repayments_adv (advance_id),
  CONSTRAINT fk_adv_rep_adv FOREIGN KEY (advance_id) REFERENCES cash_advances(id),
  CONSTRAINT fk_adv_rep_user FOREIGN KEY (recorded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS city_social_security_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  city VARCHAR(64) NOT NULL UNIQUE,
  effective_year INT NOT NULL DEFAULT 2026,
  ss_base_min DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  ss_base_max DECIMAL(12, 2) NOT NULL DEFAULT 999999.00,
  pension_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.0800,
  medical_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.0200,
  unemployment_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.0050,
  housing_fund_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.0700,
  total_personal_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.1750,
  updated_by BIGINT NULL,
  updated_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payroll_batches (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  batch_no VARCHAR(32) NOT NULL UNIQUE,
  `year_month` VARCHAR(10) NOT NULL,
  hotel_id BIGINT NULL,
  total_employees INT NOT NULL DEFAULT 0,
  total_gross DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  total_net DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  submitted_by BIGINT NOT NULL,
  paid_by BIGINT NULL,
  payment_ref VARCHAR(64) NULL,
  paid_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_payroll_batches_ym (`year_month`, status),
  CONSTRAINT fk_pay_batch_sub FOREIGN KEY (submitted_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employee_change_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  change_type VARCHAR(32) NOT NULL,
  from_hotel_id BIGINT NOT NULL,
  to_hotel_id BIGINT NOT NULL,
  from_department_id BIGINT NOT NULL,
  to_department_id BIGINT NOT NULL,
  from_position VARCHAR(80) NOT NULL,
  to_position VARCHAR(80) NOT NULL,
  from_salary DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  to_salary DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
  effective_date VARCHAR(16) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  applicant_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  executed_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_emp_change_status (status, effective_date),
  CONSTRAINT fk_emp_chg_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_emp_chg_app FOREIGN KEY (applicant_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shift_definitions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL DEFAULT 0,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  start_time VARCHAR(10) NOT NULL,
  end_time VARCHAR(10) NOT NULL,
  work_hours DECIMAL(5, 2) NOT NULL DEFAULT 8.00,
  is_night TINYINT(1) NOT NULL DEFAULT 0,
  allowance_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_shift_def_hotel_code (hotel_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS schedule_publications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  week_start VARCHAR(16) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  published_by BIGINT NULL,
  published_at VARCHAR(32) NULL,
  locked_by BIGINT NULL,
  locked_at VARCHAR(32) NULL,
  UNIQUE KEY uk_sched_pub_hotel_week (hotel_id, week_start),
  CONSTRAINT fk_sched_pub_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shift_swap_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  hotel_id BIGINT NOT NULL,
  requester_emp_id BIGINT NOT NULL,
  target_emp_id BIGINT NOT NULL,
  requester_shift_date VARCHAR(16) NOT NULL,
  target_shift_date VARCHAR(16) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_TARGET',
  current_step INT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_shift_swap_hotel (hotel_id, status),
  CONSTRAINT fk_swap_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_swap_req_emp FOREIGN KEY (requester_emp_id) REFERENCES employees(id),
  CONSTRAINT fk_swap_tgt_emp FOREIGN KEY (target_emp_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS leave_balances (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT NOT NULL,
  year INT NOT NULL,
  leave_type VARCHAR(24) NOT NULL,
  total_days DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
  used_days DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
  pending_days DECIMAL(6, 2) NOT NULL DEFAULT 0.00,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_leave_bal (employee_id, year, leave_type),
  CONSTRAINT fk_lb_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS holiday_calendar (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  holiday_date VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL,
  day_type VARCHAR(16) NOT NULL DEFAULT 'HOLIDAY',
  year INT NOT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_records (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  attendance_date VARCHAR(16) NOT NULL,
  scheduled_shift VARCHAR(24) NULL,
  check_in_time VARCHAR(16) NULL,
  check_out_time VARCHAR(16) NULL,
  work_hours DECIMAL(5, 2) NOT NULL DEFAULT 8.00,
  is_night_shift TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'NORMAL',
  is_locked TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(24) NOT NULL DEFAULT 'CSV_IMPORT',
  remark VARCHAR(255) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_att_emp_date (employee_id, attendance_date),
  INDEX idx_att_hotel_date (hotel_id, attendance_date),
  CONSTRAINT fk_att_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_att_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attendance_corrections (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  attendance_date VARCHAR(16) NOT NULL,
  check_type VARCHAR(24) NOT NULL DEFAULT 'CHECK_IN',
  corrected_time VARCHAR(16) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_att_corr_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_att_corr_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS overtime_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  overtime_date VARCHAR(16) NOT NULL,
  day_type VARCHAR(16) NOT NULL DEFAULT 'WORKDAY',
  hours DECIMAL(5, 2) NOT NULL,
  comp_mode VARCHAR(16) NOT NULL DEFAULT 'PAY',
  multiplier DECIMAL(4, 2) NOT NULL DEFAULT 1.50,
  reason VARCHAR(255) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  approved_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_ot_emp_date (employee_id, overtime_date),
  CONSTRAINT fk_ot_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_ot_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contract_renewals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_no VARCHAR(32) NOT NULL UNIQUE,
  employee_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  current_end_date VARCHAR(16) NULL,
  proposed_end_date VARCHAR(16) NULL,
  contract_term_years INT NOT NULL DEFAULT 2,
  contract_type VARCHAR(24) NOT NULL DEFAULT 'FIXED_TERM',
  proposed_salary DECIMAL(12, 2) NULL,
  remarks VARCHAR(500) NULL,
  applicant_id BIGINT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  signed_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_contract_emp (employee_id, status),
  CONSTRAINT fk_cr_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_cr_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_cr_app FOREIGN KEY (applicant_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  biz_type VARCHAR(32) NOT NULL,
  biz_id BIGINT NOT NULL,
  title VARCHAR(160) NOT NULL,
  content VARCHAR(500) NOT NULL,
  level VARCHAR(24) NOT NULL DEFAULT 'INFO',
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at VARCHAR(32) NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_notif_user_read (user_id, is_read),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reimbursement_allocations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  reimbursement_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  ratio_pct DECIMAL(6, 2) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_reimb_alloc_claim (reimbursement_id),
  CONSTRAINT fk_reimb_alloc_claim FOREIGN KEY (reimbursement_id) REFERENCES reimbursements(id) ON DELETE CASCADE,
  CONSTRAINT fk_reimb_alloc_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS petty_cash_funds (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL UNIQUE,
  quota_amount DECIMAL(12, 2) NOT NULL DEFAULT 5000.00,
  current_balance DECIMAL(12, 2) NOT NULL DEFAULT 5000.00,
  custodian_user_id BIGINT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  updated_at VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_petty_fund_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_petty_fund_custodian FOREIGN KEY (custodian_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS petty_cash_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  fund_id BIGINT NOT NULL,
  tx_type VARCHAR(24) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  balance_after DECIMAL(12, 2) NOT NULL,
  description VARCHAR(255) NOT NULL,
  operator_id BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_petty_ledger_fund (fund_id),
  CONSTRAINT fk_petty_ledger_fund FOREIGN KEY (fund_id) REFERENCES petty_cash_funds(id) ON DELETE CASCADE,
  CONSTRAINT fk_petty_ledger_op FOREIGN KEY (operator_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hotel_staffing_plans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  position VARCHAR(64) NOT NULL,
  planned_count INT NOT NULL DEFAULT 0,
  updated_by BIGINT NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_staffing_plan (hotel_id, department_id, position),
  INDEX idx_staffing_plan_hotel (hotel_id),
  CONSTRAINT fk_staffing_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_staffing_dept FOREIGN KEY (department_id) REFERENCES departments(id),
  CONSTRAINT fk_staffing_updater FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS annual_budgets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  hotel_id BIGINT NOT NULL,
  fiscal_year INT NOT NULL,
  category VARCHAR(64) NOT NULL,
  annual_amount DECIMAL(12, 2) NOT NULL,
  updated_by BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  UNIQUE KEY uk_annual_budget (hotel_id, fiscal_year, category),
  CONSTRAINT fk_annual_budget_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_annual_budget_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppliers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(128) NOT NULL,
  tax_no VARCHAR(64) NULL,
  bank_name VARCHAR(128) NOT NULL,
  bank_account VARCHAR(64) NOT NULL,
  contact_name VARCHAR(64) NULL,
  contact_phone VARCHAR(32) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_by BIGINT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT fk_supplier_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vendor_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  payment_no VARCHAR(64) NOT NULL UNIQUE,
  supplier_id BIGINT NOT NULL,
  hotel_id BIGINT NOT NULL,
  expense_month VARCHAR(16) NOT NULL,
  category VARCHAR(64) NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  invoice_no VARCHAR(64) NULL,
  description TEXT NOT NULL,
  applicant_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING_APPROVAL',
  current_step INT NOT NULL DEFAULT 1,
  paid_by BIGINT NULL,
  paid_at VARCHAR(32) NULL,
  pay_reference VARCHAR(64) NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  INDEX idx_vendor_pay_hotel (hotel_id, status),
  CONSTRAINT fk_vp_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_vp_hotel FOREIGN KEY (hotel_id) REFERENCES hotels(id),
  CONSTRAINT fk_vp_applicant FOREIGN KEY (applicant_id) REFERENCES users(id),
  CONSTRAINT fk_vp_payer FOREIGN KEY (paid_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- T3-07: Core composite indexes
CREATE INDEX idx_steps_status_biz ON approval_steps(status, biz_type, biz_id);
CREATE INDEX idx_logs_biz_created ON approval_logs(biz_type, biz_id, created_at);
CREATE INDEX idx_reimb_app_status ON reimbursements(applicant_id, status);
CREATE INDEX idx_payroll_emp_ym ON payroll_records(employee_id, `year_month`);

SET FOREIGN_KEY_CHECKS = 1;
