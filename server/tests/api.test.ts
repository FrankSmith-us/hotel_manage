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
    assert.equal(mysqlTables.length, 18);
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

    // Preview with <=1000 within budget -> 2 steps (STORE_MANAGER -> GENERAL_MANAGER), no FINANCE pre-approval
    const smallPrev = await req('POST', '/api/reimbursements/preview', {
      token: staffToken,
      body: {
        hotel_id: 2,
        expense_month: ym,
        items: [{ category: 'OTHER', amount: 500, invoice_no: 'INV-SMALL-1' }],
      },
    });
    assert.equal(smallPrev.status, 200);
    assert.deepEqual(
      smallPrev.data.route.map((s: any) => s.approverRole),
      ['STORE_MANAGER', 'GENERAL_MANAGER']
    );

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
    assert.deepEqual(
      prev.data.route.map((s: any) => s.approverRole),
      ['STORE_MANAGER', 'REGIONAL_MANAGER', 'GENERAL_MANAGER']
    ); // 店长 -> 区域 -> 总经理，无需财务前置审核
  });

  it('Full reimbursement + cash advance offset + return/resubmit + payout settlement lifecycle', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const regionToken = await loginAs('region_east');
    const gmToken = await loginAs('gm');
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
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
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
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
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
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
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

    // 6. Approve through Store Manager -> Regional Manager -> General Manager (Finance cannot pre-approve)
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    const finBlocked = await req('POST', `/api/reimbursements/${claimId}/action`, {
      token: financeToken,
      body: { action: 'APPROVE' },
    });
    assert.equal(finBlocked.status, 403);
    const gmApprove = await req('POST', `/api/reimbursements/${claimId}/action`, {
      token: gmToken,
      body: { action: 'APPROVE' },
    });
    assert.equal(gmApprove.status, 200);
    assert.equal(gmApprove.data.claim.status, 'APPROVED');

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

  it('Skips Regional Manager step across workflows when Regional Manager and General Manager are the same person', async () => {
    const adminToken = await loginAs('admin');
    const staffShToken = await loginAs('staff_sh');
    const mgrBjToken = await loginAs('mgr_bj');
    const gmToken = await loginAs('gm');
    const ym = currentYearMonth();

    // 1. Default: EAST (hotel 2) has dedicated region_east -> includes REGIONAL_MANAGER
    const eastPrev = await req('POST', '/api/reimbursements/preview', {
      token: staffShToken,
      body: {
        hotel_id: 2,
        expense_month: ym,
        items: [{ category: 'OTHER', amount: 2000 }],
      },
    });
    assert.equal(eastPrev.status, 200);
    assert.equal(eastPrev.data.skippedRegionalManager, false);
    assert.deepEqual(
      eastPrev.data.route.map((s: any) => s.approverRole),
      ['STORE_MANAGER', 'REGIONAL_MANAGER', 'GENERAL_MANAGER']
    );

    // 2. Default: NORTH (BJ-GM, hotel 4) has GM as regional manager -> skips REGIONAL_MANAGER
    const northPrev = await req('POST', '/api/reimbursements/preview', {
      token: mgrBjToken,
      body: {
        hotel_id: 4,
        expense_month: ym,
        items: [{ category: 'OTHER', amount: 2000 }],
      },
    });
    assert.equal(northPrev.status, 200);
    assert.equal(northPrev.data.skippedRegionalManager, true);
    assert.deepEqual(
      northPrev.data.route.map((s: any) => s.approverRole),
      ['GENERAL_MANAGER']
    );

    // 3. Submit reimbursement in NORTH -> routes directly to GM with AUTO_SKIP audit log
    const bjClaim = await req('POST', '/api/reimbursements', {
      token: mgrBjToken,
      body: {
        title: '北京国贸店直达总经理测试单',
        hotel_id: 4,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '高建国',
        payee_bank: '招商银行北京国贸支行',
        payee_account: '6225880200003001',
        submit: true,
        items: [{ category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 2000 }],
      },
    });
    assert.equal(bjClaim.status, 201);
    const bjDetail = await req('GET', `/api/reimbursements/${bjClaim.data.claim.id}`, { token: gmToken });
    assert.equal(bjDetail.data.approvalSteps.length, 1);
    assert.equal(bjDetail.data.approvalSteps[0].approver_role, 'GENERAL_MANAGER');
    assert.ok(bjDetail.data.approvalLogs.some((l: any) => l.action === 'AUTO_SKIP'));
    assert.equal(bjDetail.data.permissions.canApprove, true);

    // 4. Leave, Headcount, and Cash Advance in NORTH also skip REGIONAL_MANAGER -> GENERAL_MANAGER
    const bjLeave = await req('POST', '/api/leaves', {
      token: mgrBjToken,
      body: {
        leave_type: 'ANNUAL',
        start_date: todayStr(),
        end_date: todayStr(),
        days: 1,
        hours: 8,
        reason: '测试直达总经理请假',
      },
    });
    assert.equal(bjLeave.status, 201);
    const gmLeaves = await req('GET', '/api/leaves?tab=pending', { token: gmToken });
    assert.ok(gmLeaves.data.leaves.some((l: any) => Number(l.id) === Number(bjLeave.data.leave.id)));

    // 5. Dynamic switch: set EAST (region_id=2) manager to GM -> staff_sh preview immediately skips REGIONAL_MANAGER
    const tree = await req('GET', '/api/organization/tree', { token: adminToken });
    const eastRegion = tree.data.regions.find((r: any) => r.code === 'EAST');
    const gmUser = tree.data.managerCandidates.find((u: any) => u.username === 'gm');
    const regEastUser = tree.data.managerCandidates.find((u: any) => u.username === 'region_east');

    const switchToGm = await req('PUT', `/api/organization/regions/${eastRegion.id}/manager`, {
      token: adminToken,
      body: { manager_user_id: gmUser.id },
    });
    assert.equal(switchToGm.status, 200);

    const eastAfterSwitch = await req('POST', '/api/reimbursements/preview', {
      token: staffShToken,
      body: {
        hotel_id: 2,
        expense_month: ym,
        items: [{ category: 'OTHER', amount: 2000 }],
      },
    });
    assert.equal(eastAfterSwitch.data.skippedRegionalManager, true);
    assert.deepEqual(
      eastAfterSwitch.data.route.map((s: any) => s.approverRole),
      ['STORE_MANAGER', 'GENERAL_MANAGER']
    );

    // Restore EAST manager back to region_east
    await req('PUT', `/api/organization/regions/${eastRegion.id}/manager`, {
      token: adminToken,
      body: { manager_user_id: regEastUser.id },
    });
  });

  it('Supports CORPORATE/PERSONAL payees, recalls saved accounts, and auto-saves new accounts only after Finance payout', async () => {
    const mgrBjToken = await loginAs('mgr_bj');
    const gmToken = await loginAs('gm');
    const financeToken = await loginAs('finance');
    const ym = currentYearMonth();

    // 1. Missing payee fields must fail validation (400)
    const missingPayee = await req('POST', '/api/reimbursements', {
      token: mgrBjToken,
      body: {
        title: '缺少收款人测试',
        hotel_id: 4,
        expense_month: ym,
        payment_type: 'CORPORATE',
        submit: true,
        items: [{ category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 300 }],
      },
    });
    assert.equal(missingPayee.status, 400);

    // 2. Submit new CORPORATE vendor account -> NOT in saved payees yet before payout
    const newCorpAcc = '999888777666';
    const corpClaim = await req('POST', '/api/reimbursements', {
      token: mgrBjToken,
      body: {
        title: '新增对公供应商付款测试',
        hotel_id: 4,
        expense_month: ym,
        payment_type: 'CORPORATE',
        payee_name: '北京恒信设施维保有限公司',
        payee_bank: '浦发银行北京分行',
        payee_account: newCorpAcc,
        submit: true,
        items: [{ category: 'MAINTENANCE', expense_date: todayStr(), description: '消防阀更换', amount: 880 }],
      },
    });
    assert.equal(corpClaim.status, 201);
    const claimId = corpClaim.data.claim.id;

    const beforePay = await req('GET', '/api/reimbursements/payees?paymentType=CORPORATE', { token: mgrBjToken });
    assert.equal(beforePay.status, 200);
    assert.ok(!beforePay.data.payees.some((p: any) => p.account_number === newCorpAcc));

    // 3. GM approves -> Finance pays -> account is automatically saved under CORPORATE
    assert.equal(
      (await req('POST', `/api/reimbursements/${claimId}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status,
      200
    );
    assert.equal(
      (
        await req('POST', '/api/reimbursements/payout', {
          token: financeToken,
          body: { reimbursement_ids: [claimId], payment_channel: 'BANK_TRANSFER', payment_ref: 'TXN-CORP-1' },
        })
      ).status,
      200
    );

    const afterPayCorp = await req('GET', '/api/reimbursements/payees?paymentType=CORPORATE', { token: mgrBjToken });
    const savedCorp = afterPayCorp.data.payees.find((p: any) => p.account_number === newCorpAcc);
    assert.ok(savedCorp);
    assert.equal(savedCorp.account_name, '北京恒信设施维保有限公司');
    assert.equal(Number(savedCorp.paid_count), 1);

    // Ensure CORPORATE account does not leak into PERSONAL list
    const afterPayPers = await req('GET', '/api/reimbursements/payees?paymentType=PERSONAL', { token: mgrBjToken });
    assert.ok(!afterPayPers.data.payees.some((p: any) => p.account_number === newCorpAcc));
  });

  it('Targeted return-for-edit surfaces claim in target user pending list & dashboard and resumes from target node', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const regionToken = await loginAs('region_east');
    const gmToken = await loginAs('gm');
    const ym = currentYearMonth();

    // 1. staff_sh submits a 3-tier claim (2000) -> mgr_sh approves -> region_east approves -> pending at gm
    const createRes = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '定向退回修改测试单',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 2000 }],
      },
    });
    assert.equal(createRes.status, 201);
    const claimId = createRes.data.claim.id;

    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);

    // 2. GM inspects returnTargets -> sees 申请人(0), 门店店长(1), 区域经理(2)
    const gmDetail = await req('GET', `/api/reimbursements/${claimId}`, { token: gmToken });
    assert.equal(gmDetail.data.returnTargets.length, 3);
    assert.deepEqual(
      gmDetail.data.returnTargets.map((t: any) => t.stepOrder),
      [0, 1, 2]
    );

    // 3. GM returns to Step 1 (mgr_sh)
    const retToMgr = await req('POST', `/api/reimbursements/${claimId}/action`, {
      token: gmToken,
      body: { action: 'RETURN', comment: '请店长核实单价后重提', return_to_step: 1 },
    });
    assert.equal(retToMgr.status, 200);

    // mgr_sh sees it in pending list & dashboard inbox with canEdit: true; staff_sh cannot edit it
    const mgrPending = await req('GET', '/api/reimbursements?tab=pending', { token: mgrShToken });
    const foundMgr = mgrPending.data.reimbursements.find((r: any) => r.id === claimId);
    assert.ok(foundMgr);
    assert.equal(foundMgr.canEdit, true);

    const mgrDash = await req('GET', '/api/dashboard/summary', { token: mgrShToken });
    assert.ok(mgrDash.data.inbox.some((i: any) => i.biz_type === 'REIMBURSEMENT' && i.biz_id === claimId));

    const staffForbiddenEdit = await req('PUT', `/api/reimbursements/${claimId}`, {
      token: staffToken,
      body: {
        title: '越权修改',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 1800 }],
      },
    });
    assert.equal(staffForbiddenEdit.status, 403);

    // 4. mgr_sh edits & resubmits -> Step 1 is auto-approved and workflow resumes directly at Step 2 (REGIONAL_MANAGER)
    const mgrResubmit = await req('PUT', `/api/reimbursements/${claimId}`, {
      token: mgrShToken,
      body: {
        title: '定向退回修改测试单（店长已核减）',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 1800 }],
      },
    });
    assert.equal(mgrResubmit.status, 200);
    assert.equal(mgrResubmit.data.claim.current_step, 2);

    const regPending = await req('GET', '/api/reimbursements?tab=pending', { token: regionToken });
    assert.ok(regPending.data.reimbursements.some((r: any) => r.id === claimId && r.canApprove));

    // 5. region_east approves -> GM returns to Step 0 (applicant staff_sh) -> staff_sh sees it in pending & dashboard
    assert.equal((await req('POST', `/api/reimbursements/${claimId}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal(
      (
        await req('POST', `/api/reimbursements/${claimId}/action`, {
          token: gmToken,
          body: { action: 'RETURN', comment: '请申请人补充明细', return_to_step: 0 },
        })
      ).status,
      200
    );

    const staffPending = await req('GET', '/api/reimbursements?tab=pending', { token: staffToken });
    assert.ok(staffPending.data.reimbursements.some((r: any) => r.id === claimId && r.canEdit));
    const staffDash = await req('GET', '/api/dashboard/summary', { token: staffToken });
    assert.ok(staffDash.data.inbox.some((i: any) => i.biz_type === 'REIMBURSEMENT' && i.biz_id === claimId));
  });

  it('Dashboard separates expenseInbox ahead of otherInbox and marks URGENT items properly', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const ym = currentYearMonth();

    // Create an URGENT reimbursement and an URGENT leave for SH-JA
    const urgClaim = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '加急空调主板抢修报销',
        hotel_id: 2,
        expense_month: ym,
        urgency: 'URGENT',
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'MAINTENANCE', expense_date: todayStr(), description: '抢修', amount: 500 }],
      },
    });
    assert.equal(urgClaim.status, 201);

    const urgLeave = await req('POST', '/api/leaves', {
      token: staffToken,
      body: {
        leave_type: 'SICK',
        start_date: todayStr(),
        end_date: todayStr(),
        days: 1,
        hours: 8,
        reason: '加急病假申请',
        urgency: 'URGENT',
      },
    });
    assert.equal(urgLeave.status, 201);

    const dash = await req('GET', '/api/dashboard/summary', { token: mgrShToken });
    assert.equal(dash.status, 200);
    assert.ok(dash.data.kpis.pendingExpenseCount >= 1);
    assert.ok(dash.data.kpis.urgentExpenseCount >= 1);
    assert.ok(dash.data.kpis.pendingOtherCount >= 1);
    assert.ok(dash.data.kpis.urgentOtherCount >= 1);

    // expenseInbox only contains REIMBURSEMENT / CASH_ADVANCE and starts with URGENT
    assert.ok(dash.data.expenseInbox.every((i: any) => i.biz_type === 'REIMBURSEMENT' || i.biz_type === 'CASH_ADVANCE'));
    assert.equal(dash.data.expenseInbox[0].urgency, 'URGENT');

    // otherInbox only contains LEAVE / HEADCOUNT and starts with URGENT
    assert.ok(dash.data.otherInbox.every((i: any) => i.biz_type === 'LEAVE' || i.biz_type === 'HEADCOUNT'));
    assert.equal(dash.data.otherInbox[0].urgency, 'URGENT');

    // Combined inbox puts all expense items strictly before any other items
    const firstOtherIdx = dash.data.inbox.findIndex((i: any) => i.biz_type === 'LEAVE' || i.biz_type === 'HEADCOUNT');
    const lastExpenseIdx = dash.data.inbox.reduce(
      (acc: number, i: any, idx: number) =>
        i.biz_type === 'REIMBURSEMENT' || i.biz_type === 'CASH_ADVANCE' ? idx : acc,
      -1
    );
    if (firstOtherIdx !== -1 && lastExpenseIdx !== -1) {
      assert.ok(lastExpenseIdx < firstOtherIdx);
    }
  });
});
