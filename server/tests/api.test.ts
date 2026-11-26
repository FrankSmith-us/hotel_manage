import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setDb, closeDb } from '../db';
import { initSchema } from '../db/init';
import { seedDatabase } from '../db/seed';
import { SqliteAdapter } from '../db/sqliteAdapter';
import { createApp } from '../src/app';
import { currentYearMonth, getMondayOfCurrentWeek, todayStr } from '../src/utils/numbers';

let server: http.Server;
let baseUrl = '';

async function req(
  method: string,
  urlPath: string,
  options: { token?: string; body?: unknown; isForm?: boolean } = {}
): Promise<{ status: number; data: any; text: string }> {
  const headers: Record<string, string> = {};
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
  let body: any = undefined;
  if (options.body !== undefined) {
    if (options.isForm) {
      body = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }
  const res = await fetch(`${baseUrl}${urlPath}`, { method, headers, body });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

async function loginAs(username: string): Promise<string> {
  const res = await req('POST', '/api/auth/login', {
    body: { username, password: 'Hotel@2026' },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${res.text}`);
  return res.data.token;
}

describe('YueQi Hotel Ops API Integration Suite', () => {
  before(async () => {
    const db = new SqliteAdapter(':memory:');
    setDb(db);
    await initSchema(db);
    await seedDatabase(db);

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
  });

  it('MySQL and SQLite schemas define identical 17 tables', () => {
    const mysqlSql = fs.readFileSync(path.resolve(__dirname, '../db/mysql/schema.sql'), 'utf8');
    const sqliteSql = fs.readFileSync(path.resolve(__dirname, '../db/sqlite/schema.sql'), 'utf8');
    const extractTables = (sql: string) =>
      Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)).map((m) => m[1]).sort();
    const mysqlTables = extractTables(mysqlSql);
    const sqliteTables = extractTables(sqliteSql);
    assert.equal(mysqlTables.length, 17);
    assert.deepEqual(mysqlTables, sqliteTables);
  });

  it('Auth login, invalid credentials, demo switch, and RBAC isolation', async () => {
    const bad = await req('POST', '/api/auth/login', {
      body: { username: 'mgr_sh', password: 'wrong' },
    });
    assert.equal(bad.status, 401);

    const mgrShToken = await loginAs('mgr_sh');
    const staffToken = await loginAs('staff_sh');

    // Cross-store isolation: mgr_sh cannot view BJ-GM schedules (hotelId=4)
    const crossSchedule = await req('GET', '/api/schedules?hotelId=4', { token: mgrShToken });
    assert.equal(crossSchedule.status, 403);

    // STAFF cannot trigger payroll calculation or payout
    const staffPayroll = await req('POST', '/api/payroll/calculate', {
      token: staffToken,
      body: { yearMonth: currentYearMonth() },
    });
    assert.equal(staffPayroll.status, 403);

    const staffPayout = await req('POST', '/api/reimbursements/payout', {
      token: staffToken,
      body: { reimbursement_ids: [1], payment_ref: 'X' },
    });
    assert.equal(staffPayout.status, 403);
  });

  it('Reimbursement preview detects OVER_BUDGET & DUPLICATE_INVOICE, and routes dynamically', async () => {
    const staffToken = await loginAs('staff_sh');
    const ym = currentYearMonth();

    // Preview with duplicate invoice INV-2026-88012 and huge maintenance amount -> OVER_BUDGET + DUPLICATE_INVOICE
    const prev = await req('POST', '/api/reimbursements/preview', {
      token: staffToken,
      body: {
        hotel_id: 2,
        expense_month: ym,
        items: [
          { category: 'MAINTENANCE', amount: 15000, invoice_no: 'INV-2026-88012' },
        ],
      },
    });
    assert.equal(prev.status, 200);
    assert.ok(prev.data.risks.riskFlags.includes('OVER_BUDGET'));
    assert.ok(prev.data.risks.riskFlags.includes('DUPLICATE_INVOICE'));
    assert.equal(prev.data.route.length, 4); // 店长 -> 区域 -> 财务 -> 总经理
  });

  it('Full reimbursement + cash advance offset + return/resubmit + payout settlement lifecycle', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const regionToken = await loginAs('region_east');
    const financeToken = await loginAs('finance');
    const ym = currentYearMonth();

    // 1. Check available advance for SH-JA (ADV-202611-002 has 2000 available)
    const advRes = await req('GET', '/api/advances?tab=available&hotelId=2', { token: staffToken });
    assert.equal(advRes.status, 200);
    const adv2 = advRes.data.advances.find((a: any) => a.advance_no === 'ADV-202611-002');
    assert.ok(adv2);
    assert.equal(Number(adv2.available_balance), 2000);

    // 2. Staff submits claim of 1500 offsetting 1000 from ADV-202611-002
    const createRes = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '自动化测试-客房应急采购',
        hotel_id: 2,
        expense_month: ym,
        cash_advance_id: adv2.id,
        offset_amount: 1000,
        submit: true,
        items: [
          {
            category: 'LINEN_SUPPLIES',
            expense_date: todayStr(),
            description: '应急浴巾采购',
            amount: 1500,
            invoice_no: 'INV-TEST-9001',
          },
        ],
      },
    });
    assert.equal(createRes.status, 201);
    const claimId = createRes.data.claim.id;
    assert.equal(createRes.data.claim.status, 'PENDING_APPROVAL');
    assert.equal(Number(createRes.data.claim.net_pay_amount), 500);

    // 3. Double-offset guard: another claim trying to offset 1500 (> remaining 1000) must fail
    const overOffset = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '超额冲销拦截测试',
        hotel_id: 2,
        expense_month: ym,
        cash_advance_id: adv2.id,
        offset_amount: 1500,
        submit: true,
        items: [
          { category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 1600 },
        ],
      },
    });
    assert.equal(overOffset.status, 400);

    // 4. Store manager returns the claim
    const retRes = await req('POST', `/api/reimbursements/${claimId}/action`, {
      token: mgrShToken,
      body: { action: 'RETURN', comment: '请补充发票说明' },
    });
    assert.equal(retRes.status, 200);

    // 5. Staff edits & resubmits with full 2000 offset (total 2200, net 200)
    const updRes = await req('PUT', `/api/reimbursements/${claimId}`, {
      token: staffToken,
      body: {
        title: '自动化测试-客房应急采购（已补全）',
        hotel_id: 2,
        expense_month: ym,
        cash_advance_id: adv2.id,
        offset_amount: 2000,
        submit: true,
        items: [
          {
            category: 'LINEN_SUPPLIES',
            expense_date: todayStr(),
            description: '应急浴巾及拖鞋采购',
            amount: 2200,
            invoice_no: 'INV-TEST-9001',
          },
        ],
      },
    });
    assert.equal(updRes.status, 200);
    assert.equal(updRes.data.claim.status, 'PENDING_APPROVAL');

    // 6. Approve through Store Manager -> Regional Manager -> Finance
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    const finApprove = await req('POST', `/api/reimbursements/${claimId}/action`, {
      token: financeToken,
      body: { action: 'APPROVE' },
    });
    assert.equal(finApprove.status, 200);
    assert.equal(finApprove.data.claim.status, 'APPROVED');

    // 7. Finance batch payout -> claim PAID & advance SETTLED
    const payoutRes = await req('POST', '/api/reimbursements/payout', {
      token: financeToken,
      body: {
        reimbursement_ids: [claimId],
        payment_channel: 'BANK_TRANSFER',
        payment_ref: 'TXN-TEST-888',
      },
    });
    assert.equal(payoutRes.status, 200);

    const detail = await req('GET', `/api/reimbursements/${claimId}`, { token: financeToken });
    assert.equal(detail.data.claim.status, 'PAID');
    assert.equal(detail.data.cashAdvance.status, 'SETTLED');
    assert.equal(Number(detail.data.cashAdvance.offset_amount), 2000);
    assert.ok(detail.data.approvalLogs.some((l: any) => l.action === 'RETURN'));
    assert.ok(detail.data.approvalLogs.some((l: any) => l.action === 'RESUBMIT'));
    assert.ok(detail.data.approvalLogs.some((l: any) => l.action === 'PAY'));
  });

  it('HR workflow: shift scheduling, payroll auto-calculation, and candidate one-click hire', async () => {
    const hrToken = await loginAs('hr');
    const mgrShToken = await loginAs('mgr_sh');
    const ym = currentYearMonth();
    const monday = getMondayOfCurrentWeek();

    // 1. Assign cross-store shift
    const shiftRes = await req('PUT', '/api/schedules/assign', {
      token: mgrShToken,
      body: {
        assignments: [
          {
            employee_id: 7,
            shift_date: monday,
            shift_type: 'NIGHT',
            assigned_hotel_id: 3,
            notes: '支援杭州西湖店夜审',
          },
        ],
      },
    });
    assert.equal(shiftRes.status, 200);

    // 2. Calculate current month payroll
    const calcRes = await req('POST', '/api/payroll/calculate', {
      token: hrToken,
      body: { yearMonth: ym },
    });
    assert.equal(calcRes.status, 200);
    assert.ok(calcRes.data.processedCount > 0);

    const payrollList = await req('GET', `/api/payroll?yearMonth=${ym}`, { token: hrToken });
    assert.equal(payrollList.status, 200);
    const emp7Pay = payrollList.data.records.find((r: any) => Number(r.employee_id) === 7);
    assert.ok(emp7Pay);
    assert.ok(Number(emp7Pay.night_shifts) >= 1);
    assert.ok(Number(emp7Pay.night_allowance) >= 80);

    // 3. Candidate one-click hire
    const cands = await req('GET', '/api/recruitment/candidates', { token: hrToken });
    const offered = cands.data.candidates.find((c: any) => c.stage === 'OFFERED');
    assert.ok(offered);
    const hireRes = await req('POST', `/api/recruitment/candidates/${offered.id}/hire`, {
      token: hrToken,
      body: { username: 'new_hire_test' },
    });
    assert.equal(hireRes.status, 201);
    assert.equal(hireRes.data.username, 'new_hire_test');

    // Newly hired user can log in immediately
    const newHireToken = await loginAs('new_hire_test');
    assert.ok(newHireToken);
  });
});
