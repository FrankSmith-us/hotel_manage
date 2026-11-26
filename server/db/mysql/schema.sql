-- 悦栖连锁酒店内部日常业务管理系统 - MySQL 8.0 Schema
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS regions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  manager_user_id BIGINT NULL,
  created_at VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hotels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  region_id BIGINT NOT NULL,
  city VARCHAR(64) NOT NULL,
  address VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  room_count INT NOT NULL DEFAULT 0,
  is_hq TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
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
  id_card_last4 VARCHAR(8) NOT NULL DEFAULT '0000',
  hotel_id BIGINT NOT NULL,
  department_id BIGINT NOT NULL,
  position VARCHAR(80) NOT NULL,
  employment_type VARCHAR(24) NOT NULL DEFAULT 'FULL_TIME',
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  hire_date VARCHAR(16) NOT NULL,
  probation_end_date VARCHAR(16) NULL,
  contract_end_date VARCHAR(16) NULL,
  health_cert_no VARCHAR(64) NULL,
  health_cert_expiry VARCHAR(16) NULL,
  base_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
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
  night_shifts INT NOT NULL DEFAULT 0,
  night_allowance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  overtime_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  leave_deduction_days DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  leave_deduction DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  performance_bonus DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  social_security DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  net_pay DECIMAL(12,2) NOT NULL DEFAULT 0.00,
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
  purpose VARCHAR(255) NOT NULL,
  expected_settle_date VARCHAR(16) NOT NULL,
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
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  current_step INT NOT NULL DEFAULT 0,
  total_steps INT NOT NULL DEFAULT 0,
  risk_flags VARCHAR(120) NOT NULL DEFAULT '',
  risk_summary VARCHAR(500) NULL,
  remarks VARCHAR(500) NULL,
  payment_type VARCHAR(24) NOT NULL DEFAULT 'PERSONAL',
  payee_name VARCHAR(80) NOT NULL,
  payee_bank VARCHAR(80) NULL,
  payee_account VARCHAR(64) NULL,
  payment_channel VARCHAR(32) NULL,
  payment_ref VARCHAR(64) NULL,
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
  created_at VARCHAR(32) NOT NULL,
  INDEX idx_steps_biz (biz_type, biz_id, step_order)
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

SET FOREIGN_KEY_CHECKS = 1;
