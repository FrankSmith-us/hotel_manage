import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setDb, closeDb, getDb } from '../db';
import { initSchema } from '../db/init';
import { seedDatabase } from '../db/seed';
import { SqliteAdapter } from '../db/sqliteAdapter';
import { createApp } from '../src/app';
import { currentYearMonth, getMondayOfCurrentWeek, nowIso, todayStr } from '../src/utils/numbers';

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

async function loginAs(username: string, password = 'Hotel@2026'): Promise<string> {
  const res = await req('POST', '/api/auth/login', {
    body: { username, password },
  });
  assert.equal(res.status, 200, `Login failed for ${username}: ${res.text}`);
  return res.data.token;
}

describe('YueQi Hotel Ops API Integration Suite', () => {
  before(async () => {
    process.env.DEMO_ROLE_SWITCH = 'true';
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

  it('MySQL and SQLite schemas define identical 33 tables', () => {
    const mysqlSql = fs.readFileSync(path.resolve(__dirname, '../db/mysql/schema.sql'), 'utf8');
    const sqliteSql = fs.readFileSync(path.resolve(__dirname, '../db/sqlite/schema.sql'), 'utf8');
    const extractTables = (sql: string) =>
      Array.from(sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/gi)).map((m) => m[1]).sort();
    const mysqlTables = extractTables(mysqlSql);
    const sqliteTables = extractTables(sqliteSql);
    assert.equal(mysqlTables.length, 33);
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
            attachment_url: '/seed-assets/invoice-sample-1.svg',
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
          { category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 1600, attachment_url: '/seed-assets/invoice-sample-1.svg' },
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
            attachment_url: '/seed-assets/invoice-sample-1.svg',
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

    // Newly hired user can log in immediately with returned initialPassword
    assert.ok(hireRes.data.initialPassword && hireRes.data.initialPassword !== 'Hotel@2026');
    const loginNewHire = await req('POST', '/api/auth/login', {
      body: { username: 'new_hire_test', password: hireRes.data.initialPassword },
    });
    assert.equal(loginNewHire.status, 200);
    assert.ok(loginNewHire.data.token);
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
        items: [{ category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 2000, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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
        items: [{ category: 'MAINTENANCE', expense_date: todayStr(), description: '消防阀更换', amount: 880, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 2000, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 1800, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 1800, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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
        items: [{ category: 'MAINTENANCE', expense_date: todayStr(), description: '抢修', amount: 500, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
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

  it('Every employee in approval forms has a login account and can view applied and approved statuses', async () => {
    const db = getDb();

    // 1. Every employee appearing in any workflow table (and all 16 seeded employees) has an active user account
    const missingUsers = await db.query<{ emp_no: string; name: string }>(
      `SELECT e.emp_no, e.name
       FROM employees e
       LEFT JOIN users u ON u.employee_id = e.id AND u.is_active = 1
       WHERE u.id IS NULL`
    );
    assert.equal(missingUsers.length, 0, `Employees without active accounts: ${JSON.stringify(missingUsers)}`);

    const allDemoRes = await req('GET', '/api/auth/demo-accounts');
    assert.equal(allDemoRes.status, 200);
    assert.ok(allDemoRes.data.accounts.length >= 16);

    // Log in as newly added accounts & verify each can log in with Hotel@2026
    const staffShHkToken = await loginAs('staff_sh_hk');
    const staffShEngToken = await loginAs('staff_sh_eng');
    const staffHzToken = await loginAs('staff_hz');
    const staffBjFoToken = await loginAs('staff_bj_fo');
    const mgrHzToken = await loginAs('mgr_hz');
    const mgrBjToken = await loginAs('mgr_bj');
    const mgrSzToken = await loginAs('mgr_sz');
    const regionToken = await loginAs('region_east');
    const gmToken = await loginAs('gm');
    const hrToken = await loginAs('hr');
    const financeToken = await loginAs('finance');

    // 2. Submitting employees see their own applications and live statuses via tab=mine and Dashboard
    const hkMineLeaves = await req('GET', '/api/leaves?tab=mine', { token: staffShHkToken });
    assert.ok(hkMineLeaves.data.leaves.some((l: any) => l.request_no === 'LV-202611-002' && l.status === 'PENDING_APPROVAL'));

    const hkMineReimb = await req('GET', '/api/reimbursements?tab=mine', { token: staffShHkToken });
    assert.ok(hkMineReimb.data.reimbursements.some((r: any) => r.claim_no === 'BX-202611-009' && r.status === 'PENDING_APPROVAL'));

    const engMineReimb = await req('GET', '/api/reimbursements?tab=mine', { token: staffShEngToken });
    assert.ok(engMineReimb.data.reimbursements.some((r: any) => r.claim_no === 'BX-202611-010' && r.status === 'APPROVED'));

    const hzMineAdv = await req('GET', '/api/advances?tab=mine', { token: staffHzToken });
    assert.ok(hzMineAdv.data.advances.some((a: any) => a.advance_no === 'ADV-202611-004' && a.status === 'PENDING_APPROVAL'));

    const szDash = await req('GET', '/api/dashboard/summary', { token: mgrSzToken });
    assert.ok(szDash.data.myApplications.some((i: any) => i.code === 'BX-202611-013' && i.status === 'PENDING_APPROVAL'));

    // 3. Approvers see previously approved/handled items across all 4 workflows via tab=handled & Dashboard
    const hzHandledReimb = await req('GET', '/api/reimbursements?tab=handled', { token: mgrHzToken });
    assert.ok(
      hzHandledReimb.data.reimbursements.some(
        (r: any) => r.claim_no === 'BX-202611-011' && r.my_last_action === 'APPROVE' && r.status === 'PENDING_APPROVAL'
      )
    );
    const hzHandledLeaves = await req('GET', '/api/leaves?tab=handled', { token: mgrHzToken });
    assert.ok(hzHandledLeaves.data.leaves.some((l: any) => l.request_no === 'LV-202611-005'));
    const hzHandledAdv = await req('GET', '/api/advances?tab=handled', { token: mgrHzToken });
    assert.ok(hzHandledAdv.data.advances.some((a: any) => a.advance_no === 'ADV-202611-004'));

    const regHandledHc = await req('GET', '/api/recruitment/headcounts?tab=handled', { token: regionToken });
    assert.ok(regHandledHc.data.headcounts.some((hc: any) => hc.request_no === 'HC-202611-003'));

    const hrHandledHc = await req('GET', '/api/recruitment/headcounts?tab=handled', { token: hrToken });
    assert.ok(hrHandledHc.data.headcounts.some((hc: any) => hc.request_no === 'HC-202611-002' && hc.status === 'APPROVED'));

    const finDash = await req('GET', '/api/dashboard/summary', { token: financeToken });
    assert.ok(finDash.data.myHandledApprovals.length > 0);

    // 4. Dynamic status propagation: mgr_bj approves BX-202611-012 -> appears in mgr_bj handled as PENDING_APPROVAL (at GM) -> gm approves -> both mgr_bj handled & staff_bj_fo mine show APPROVED
    const bjPending = await req('GET', '/api/reimbursements?tab=pending', { token: mgrBjToken });
    const bx12 = bjPending.data.reimbursements.find((r: any) => r.claim_no === 'BX-202611-012');
    assert.ok(bx12);

    assert.equal(
      (await req('POST', `/api/reimbursements/${bx12.id}/action`, { token: mgrBjToken, body: { action: 'APPROVE' } })).status,
      200
    );

    const bjHandledAfterMgr = await req('GET', '/api/reimbursements?tab=handled', { token: mgrBjToken });
    const bx12AtGm = bjHandledAfterMgr.data.reimbursements.find((r: any) => r.id === bx12.id);
    assert.ok(bx12AtGm);
    assert.equal(bx12AtGm.status, 'PENDING_APPROVAL');
    assert.equal(bx12AtGm.my_last_action, 'APPROVE');

    assert.equal(
      (await req('POST', `/api/reimbursements/${bx12.id}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status,
      200
    );

    const bjHandledAfterGm = await req('GET', '/api/reimbursements?tab=handled', { token: mgrBjToken });
    const bx12Approved = bjHandledAfterGm.data.reimbursements.find((r: any) => r.id === bx12.id);
    assert.equal(bx12Approved.status, 'APPROVED');
    assert.match(bx12Approved.status_detail, /待财务付款/);

    const staffBjDash = await req('GET', '/api/dashboard/summary', { token: staffBjFoToken });
    const bx12StaffView = staffBjDash.data.myApplications.find((i: any) => i.code === 'BX-202611-012');
    assert.ok(bx12StaffView);
    assert.equal(bx12StaffView.status, 'APPROVED');
  });

  it('Audit P0/P1 security controls: demo switch guard, ownership, data isolation, uploads, and state-machine integrity', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const regionToken = await loginAs('region_east');
    const hrToken = await loginAs('hr');
    const adminToken = await loginAs('admin');
    const ym = currentYearMonth();

    // P0-01: When DEMO_ROLE_SWITCH is disabled, /demo-accounts returns enabled:false and /demo-switch returns 403
    const prevDemoSwitch = process.env.DEMO_ROLE_SWITCH;
    process.env.DEMO_ROLE_SWITCH = 'false';
    try {
      const demoAcc = await req('GET', '/api/auth/demo-accounts');
      assert.equal(demoAcc.status, 200);
      assert.equal(demoAcc.data.enabled, false);
      const demoSw = await req('POST', '/api/auth/demo-switch', { body: { username: 'gm' } });
      assert.equal(demoSw.status, 403);
    } finally {
      process.env.DEMO_ROLE_SWITCH = prevDemoSwitch;
    }

    // P0-02: STAFF cannot view or offset another user's cash advance (ADV-202611-001 belongs to mgr_sh)
    const availForStaff = await req('GET', '/api/advances?tab=available&hotelId=2', { token: staffToken });
    assert.equal(availForStaff.status, 200);
    assert.ok(!availForStaff.data.advances.some((a: any) => a.advance_no === 'ADV-202611-001'));

    const allAdvs = await req('GET', '/api/advances?tab=all', { token: mgrShToken });
    const mgrAdv = allAdvs.data.advances.find((a: any) => a.advance_no === 'ADV-202611-001');
    assert.ok(mgrAdv);
    const crossOffset = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '越权冲销他人借款测试',
        hotel_id: 2,
        expense_month: ym,
        cash_advance_id: mgrAdv.id,
        offset_amount: 100,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 200, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
      },
    });
    assert.equal(crossOffset.status, 403);

    // P0-03: Intermediate approver cannot tamper with payee_account on returned claim; changing amount at step 2 resets workflow to step 1
    const cRes = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: 'P0-03防篡改测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '布草', amount: 1500, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
      },
    });
    assert.equal(cRes.status, 201);
    const cid = cRes.data.claim.id;
    assert.equal((await req('POST', `/api/reimbursements/${cid}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/reimbursements/${cid}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    const gmToken = await loginAs('gm');
    assert.equal(
      (
        await req('POST', `/api/reimbursements/${cid}/action`, {
          token: gmToken,
          body: { action: 'RETURN', comment: '退回区域复核', return_to_step: 2 },
        })
      ).status,
      200
    );

    const tamperPayee = await req('PUT', `/api/reimbursements/${cid}`, {
      token: regionToken,
      body: {
        title: 'P0-03防篡改测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '王海峰',
        payee_bank: '招商银行上海分行',
        payee_account: '6225880100001004',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '布草', amount: 1500, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
      },
    });
    assert.equal(tamperPayee.status, 403);

    const amtChangedResubmit = await req('PUT', `/api/reimbursements/${cid}`, {
      token: regionToken,
      body: {
        title: 'P0-03改金额重审测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '布草', amount: 1900, attachment_url: '/seed-assets/invoice-sample-1.svg' }],
      },
    });
    assert.equal(amtChangedResubmit.status, 200);
    assert.equal(amtChangedResubmit.data.claim.current_step, 1);

    // P0-04 & P0-05: STORE_MANAGER cannot modify salary/bank_account; HR cannot modify own salary; STAFF only sees self
    const mgrSalaryEdit = await req('PUT', '/api/employees/7', {
      token: mgrShToken,
      body: { base_salary: 99999 },
    });
    assert.equal(mgrSalaryEdit.status, 403);

    const hrSelfEdit = await req('PUT', '/api/employees/2', {
      token: hrToken,
      body: { base_salary: 88888 },
    });
    assert.equal(hrSelfEdit.status, 403);

    const staffEmpList = await req('GET', '/api/employees', { token: staffToken });
    assert.equal(staffEmpList.status, 200);
    assert.equal(staffEmpList.data.employees.length, 1);
    assert.equal(Number(staffEmpList.data.employees[0].id), 7);

    const staffViewColleague = await req('GET', '/api/employees/6', { token: staffToken });
    assert.equal(staffViewColleague.status, 403);

    const staffViewColleagueClaim = await req('GET', '/api/reimbursements/1', { token: staffToken });
    assert.equal(staffViewColleagueClaim.status, 403);

    // P1-04 & P1-05 & P1-06 & P1-07: Duplicate invoice blocked on submit; STAFF blocked from exports/candidates; /uploads requires auth
    const dupClaim = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '重复发票拦截测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'OTHER', expense_date: todayStr(), description: '测试', amount: 100, invoice_no: 'INV-2026-88012' }],
      },
    });
    assert.equal(dupClaim.status, 400);

    const staffExport = await req('GET', `/api/reports/expenses/export?yearMonth=${ym}`, { token: staffToken });
    assert.equal(staffExport.status, 403);

    const staffCands = await req('GET', '/api/recruitment/candidates', { token: staffToken });
    assert.equal(staffCands.status, 403);

    const unauthUpload = await req('GET', '/uploads/nonexistent.png');
    assert.equal(unauthUpload.status, 401);

    // P1-11 & P1-12: STORE_MANAGER cannot assign shift to self or cross-region; region manager must be REGIONAL_MANAGER/GENERAL_MANAGER
    const monday = getMondayOfCurrentWeek();
    const selfShift = await req('PUT', '/api/schedules/assign', {
      token: mgrShToken,
      body: { assignments: [{ employee_id: 6, shift_date: monday, shift_type: 'NIGHT' }] },
    });
    assert.equal(selfShift.status, 403);

    const crossRegionShift = await req('PUT', '/api/schedules/assign', {
      token: mgrShToken,
      body: { assignments: [{ employee_id: 7, shift_date: monday, shift_type: 'MORNING', assigned_hotel_id: 4 }] },
    });
    assert.equal(crossRegionShift.status, 403);

    const hrSetReg = await req('PUT', '/api/organization/regions/2/manager', {
      token: hrToken,
      body: { manager_user_id: 8 },
    });
    assert.equal(hrSetReg.status, 403);

    const adminSetStaffReg = await req('PUT', '/api/organization/regions/2/manager', {
      token: adminToken,
      body: { manager_user_id: 8 },
    });
    assert.equal(adminSetStaffReg.status, 400);

    // P1-08: Resignation deactivates user login
    const onboardRes = await req('POST', '/api/employees', {
      token: hrToken,
      body: {
        name: '离职测试员工',
        phone: '13811112222',
        hotel_id: 2,
        department_id: 5,
        position: '前厅专员',
        base_salary: 6000,
        hire_date: todayStr(),
      },
    });
    assert.equal(onboardRes.status, 201);
    const db = getDb();
    await db.execute(
      `INSERT INTO users (username, password_hash, display_name, role, employee_id, hotel_id, region_id, is_active, created_at)
       VALUES ('resign_test_u', '$2a$08$invalidhash', '离职测试员工', 'STAFF', ?, 2, 2, 1, ?)`,
      [onboardRes.data.employee.id, todayStr()]
    );
    const resignRes = await req('POST', `/api/employees/${onboardRes.data.employee.id}/lifecycle`, {
      token: hrToken,
      body: { event_type: 'RESIGN', reason: '个人原因离职' },
    });
    assert.equal(resignRes.status, 200);
    const uAfterResign = await db.queryOne<{ is_active: number }>('SELECT is_active FROM users WHERE username = ?', ['resign_test_u']);
    assert.equal(Number(uAfterResign?.is_active), 0);
  });

  it('Organization hotel creation validates region_id, prevents duplicate code, and initializes 5 departments', async () => {
    const adminToken = await loginAs('admin');
    const tree = await req('GET', '/api/organization/tree', { token: adminToken });
    assert.equal(tree.status, 200);
    assert.ok(Array.isArray(tree.data.regionOptions) && tree.data.regionOptions.length >= 3);

    const eastOption = tree.data.regionOptions.find((r: any) => r.code === 'EAST');
    assert.ok(eastOption);

    const badRegion = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'BAD-REG-1',
        name: '无效大区门店',
        region_id: 9999,
        city: '上海',
        address: '测试路1号',
        phone: '18000000000',
        room_count: 100,
      },
    });
    assert.equal(badRegion.status, 400);

    const created = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'SH-JA-XFH',
        name: '星方汇',
        region_id: eastOption.id,
        city: '上海',
        address: '上海市静安区星方汇大厦',
        phone: '18000000000',
        room_count: 120,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.hotel.code, 'SH-JA-XFH');

    const dupCode = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'sh-ja-xfh',
        name: '星方汇重复',
        region_id: eastOption.id,
        city: '上海',
        address: '上海市静安区星方汇大厦',
        phone: '18000000000',
        room_count: 120,
      },
    });
    assert.equal(dupCode.status, 409);
  });

  it('Master data system configuration: RBAC, cascading geography/departments/positions, delete guards, and audit logs', async () => {
    const adminToken = await loginAs('admin');
    const hrToken = await loginAs('hr');
    const staffToken = await loginAs('staff_sh');

    // 1. Non-HQ_ADMIN cannot mutate master data
    const hrCreateCity = await req('POST', '/api/master-data/cities', {
      token: hrToken,
      body: { region_id: 2, code: 'WH', name: '武汉市' },
    });
    assert.equal(hrCreateCity.status, 403);
    const staffCreateDict = await req('POST', '/api/master-data/dicts', {
      token: staffToken,
      body: { dict_type: 'EDUCATION', code: 'POSTDOC', label: '博士后' },
    });
    assert.equal(staffCreateDict.status, 403);

    // 2. HQ_ADMIN creates Region -> City -> District -> Hotel (RENOVATING)
    const regRes = await req('POST', '/api/master-data/regions', {
      token: adminToken,
      body: { code: 'WEST', name: '西南大区' },
    });
    assert.equal(regRes.status, 201);
    const regId = regRes.data.region.id;

    const cityRes = await req('POST', '/api/master-data/cities', {
      token: adminToken,
      body: { region_id: regId, code: 'CD', name: '成都市', sort_order: 10 },
    });
    assert.equal(cityRes.status, 201);
    const cityId = cityRes.data.city.id;

    const distRes = await req('POST', '/api/master-data/districts', {
      token: adminToken,
      body: { city_id: cityId, code: 'CD-JN', name: '锦江区', sort_order: 1 },
    });
    assert.equal(distRes.status, 201);
    const distId = distRes.data.district.id;

    const newHotel = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'CD-CHX',
        name: '成都春熙路悦栖店',
        region_id: regId,
        city_id: cityId,
        district_id: distId,
        status: 'RENOVATING',
        address: '成都市锦江区春熙路88号',
        phone: '028-88886666',
        room_count: 140,
      },
    });
    assert.equal(newHotel.status, 201);
    assert.equal(newHotel.data.hotel.status, 'RENOVATING');
    assert.equal(newHotel.data.hotel.city, '成都市');
    assert.equal(newHotel.data.hotel.district, '锦江区');

    // 3. Delete protection: referenced Region, City, District, and system/used DictItem return 409
    assert.equal((await req('DELETE', `/api/master-data/regions/${regId}`, { token: adminToken })).status, 409);
    assert.equal((await req('DELETE', `/api/master-data/cities/${cityId}`, { token: adminToken })).status, 409);
    assert.equal((await req('DELETE', `/api/master-data/districts/${distId}`, { token: adminToken })).status, 409);

    // 4. Separate positions per org_level (HQ vs STORE) & level-mismatch guard (400)
    const mdAll = await req('GET', '/api/master-data/all', { token: adminToken });
    const hqFinDept = mdAll.data.deptTemplates.find((d: any) => d.org_level === 'HQ' && d.code === 'FIN');
    const storeAdmDept = mdAll.data.deptTemplates.find((d: any) => d.org_level === 'STORE' && d.code === 'ADM');
    assert.ok(hqFinDept && storeAdmDept);

    const mismatchPos = await req('POST', '/api/master-data/positions', {
      token: adminToken,
      body: { org_level: 'HQ', dept_template_id: storeAdmDept.id, code: 'BAD_POS', name: '错层职位' },
    });
    assert.equal(mismatchPos.status, 400);

    const tempPos = await req('POST', '/api/master-data/positions', {
      token: adminToken,
      body: { org_level: 'HQ', dept_template_id: hqFinDept.id, code: 'HQ_TAX_SPEC', name: '税务专员' },
    });
    assert.equal(tempPos.status, 201);
    const tempPosId = tempPos.data.position.id;

    // Update & Delete unreferenced position, then verify audit logs capture CREATE / UPDATE / DELETE
    assert.equal(
      (
        await req('PUT', `/api/master-data/positions/${tempPosId}`, {
          token: adminToken,
          body: { org_level: 'HQ', dept_template_id: hqFinDept.id, code: 'HQ_TAX_SPEC', name: '高级税务专员', sort_order: 5, is_active: true },
        })
      ).status,
      200
    );
    assert.equal((await req('DELETE', `/api/master-data/positions/${tempPosId}`, { token: adminToken })).status, 200);

    const auditRes = await req('GET', '/api/master-data/audit-logs?keyword=HQ_TAX_SPEC', { token: adminToken });
    assert.equal(auditRes.status, 200);
    const actions = auditRes.data.logs.map((l: any) => l.action);
    assert.ok(actions.includes('CREATE') && actions.includes('UPDATE') && actions.includes('DELETE'));
  });

  it('Master data sort_order auto-increments monotonically and never reuses deleted numbers', async () => {
    const adminToken = await loginAs('admin');

    // 1. Regions: seeded 1..4; Test 13 created WEST -> 5. Creating another gets 6; delete 6 -> next gets 7 (not 6)
    const r6 = await req('POST', '/api/master-data/regions', {
      token: adminToken,
      body: { code: 'CENTRAL', name: '华中大区' },
    });
    assert.equal(r6.status, 201);
    assert.equal(r6.data.region.sort_order, 6);
    assert.equal((await req('DELETE', `/api/master-data/regions/${r6.data.region.id}`, { token: adminToken })).status, 200);

    const r7 = await req('POST', '/api/master-data/regions', {
      token: adminToken,
      body: { code: 'NWEST', name: '西北大区' },
    });
    assert.equal(r7.status, 201);
    assert.equal(r7.data.region.sort_order, 7);

    // 2. Cities: seeded 1..7; Test 13 created CD (ignored sort_order: 10) -> 8. Next gets 9; delete 9 -> next gets 10
    const c9 = await req('POST', '/api/master-data/cities', {
      token: adminToken,
      body: { region_id: r7.data.region.id, code: 'XA', name: '西安市' },
    });
    assert.equal(c9.status, 201);
    assert.equal(c9.data.city.sort_order, 9);
    assert.equal((await req('DELETE', `/api/master-data/cities/${c9.data.city.id}`, { token: adminToken })).status, 200);

    const c10 = await req('POST', '/api/master-data/cities', {
      token: adminToken,
      body: { region_id: r7.data.region.id, code: 'LZ', name: '兰州市' },
    });
    assert.equal(c10.status, 201);
    assert.equal(c10.data.city.sort_order, 10);

    // 3. Districts (scoped per city): new city starts at 1, then 2 -> delete 2 -> next gets 3
    const d1 = await req('POST', '/api/master-data/districts', {
      token: adminToken,
      body: { city_id: c10.data.city.id, code: 'LZ-CG', name: '城关区' },
    });
    const d2 = await req('POST', '/api/master-data/districts', {
      token: adminToken,
      body: { city_id: c10.data.city.id, code: 'LZ-QLH', name: '七里河区' },
    });
    assert.equal(d1.data.district.sort_order, 1);
    assert.equal(d2.data.district.sort_order, 2);
    assert.equal((await req('DELETE', `/api/master-data/districts/${d2.data.district.id}`, { token: adminToken })).status, 200);
    const d3 = await req('POST', '/api/master-data/districts', {
      token: adminToken,
      body: { city_id: c10.data.city.id, code: 'LZ-AN', name: '安宁区' },
    });
    assert.equal(d3.data.district.sort_order, 3);

    // 4. Deleting a seeded tail dict item (EDUCATION / DOCTOR = 6) does NOT allow next item to reuse 6 -> gets 7
    const mdAll = await req('GET', '/api/master-data/all', { token: adminToken });
    const doctorItem = mdAll.data.dictItems.find((i: any) => i.dict_type === 'EDUCATION' && i.code === 'DOCTOR');
    assert.ok(doctorItem && doctorItem.sort_order === 6);
    assert.equal((await req('DELETE', `/api/master-data/dicts/${doctorItem.id}`, { token: adminToken })).status, 200);

    const newEdu = await req('POST', '/api/master-data/dicts', {
      token: adminToken,
      body: { dict_type: 'EDUCATION', code: 'POSTDOC', label: '博士后' },
    });
    assert.equal(newEdu.status, 201);
    assert.equal(newEdu.data.item.sort_order, 7);

    // 5. Dept templates & Job positions monotonic non-reuse
    const hqDept7 = await req('POST', '/api/master-data/dept-templates', {
      token: adminToken,
      body: { org_level: 'HQ', code: 'AUDIT', name: '内审风控部', category: 'ADMIN' },
    });
    assert.equal(hqDept7.status, 201);
    assert.equal(hqDept7.data.deptTemplate.sort_order, 7);
    assert.equal((await req('DELETE', `/api/master-data/dept-templates/${hqDept7.data.deptTemplate.id}`, { token: adminToken })).status, 200);
    const hqDept8 = await req('POST', '/api/master-data/dept-templates', {
      token: adminToken,
      body: { org_level: 'HQ', code: 'LEGAL', name: '法务合规部', category: 'ADMIN' },
    });
    assert.equal(hqDept8.status, 201);
    assert.equal(hqDept8.data.deptTemplate.sort_order, 8);

    const pos1 = await req('POST', '/api/master-data/positions', {
      token: adminToken,
      body: { org_level: 'HQ', dept_template_id: hqDept8.data.deptTemplate.id, code: 'HQ_COUNSEL', name: '法务总监' },
    });
    assert.equal(pos1.status, 201);
    assert.equal(pos1.data.position.sort_order, 1);
    assert.equal((await req('DELETE', `/api/master-data/positions/${pos1.data.position.id}`, { token: adminToken })).status, 200);
    const pos2 = await req('POST', '/api/master-data/positions', {
      token: adminToken,
      body: { org_level: 'HQ', dept_template_id: hqDept8.data.deptTemplate.id, code: 'HQ_LEGAL_SPEC', name: '合规专员' },
    });
    assert.equal(pos2.status, 201);
    assert.equal(pos2.data.position.sort_order, 2);
  });

  it('Onboarding & Offboarding workflows complete and archive resigned employee historical records', async () => {
    const mgrShToken = await loginAs('mgr_sh');
    const regionToken = await loginAs('region_east');
    const hrToken = await loginAs('hr');
    const staffHkToken = await loginAs('staff_sh_hk');

    // 1. Onboarding workflow: mgr_sh submits -> region_east approves -> hr approves -> hr completes
    const obCreate = await req('POST', '/api/hr-flows/onboarding', {
      token: mgrShToken,
      body: {
        candidate_name: '林新宇',
        gender: 'M',
        phone: '13900001111',
        hotel_id: 2,
        department_id: 5,
        position: '礼宾接待员',
        planned_hire_date: todayStr(),
        base_salary: 6200,
        create_user_account: true,
        remarks: '新员工入职审批测试',
      },
    });
    assert.equal(obCreate.status, 201);
    const obId = obCreate.data.request.id;

    assert.equal((await req('POST', `/api/hr-flows/onboarding/${obId}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/hr-flows/onboarding/${obId}/action`, { token: hrToken, body: { action: 'APPROVE' } })).status, 200);

    const obComplete = await req('POST', `/api/hr-flows/onboarding/${obId}/complete`, {
      token: hrToken,
      body: { checklist: { contract_signed: true, badge_issued: true } },
    });
    assert.equal(obComplete.status, 200);
    assert.ok(obComplete.data.employeeId);
    assert.ok(obComplete.data.username);

    // Newly onboarded employee account can log in with generated temp password
    const newStaffToken = await loginAs(obComplete.data.username, obComplete.data.temp_password);
    assert.ok(newStaffToken);

    // 2. Offboarding workflow + archiving: staff_sh_hk (YQ-1002) submits or mgr_sh submits for seeded/new employee
    // Use the newly onboarded employee for a clean end-to-end resignation + archive check, AND verify seeded OFF-202611-001
    const seededOffList = await req('GET', '/api/hr-flows/offboarding', { token: staffHkToken });
    assert.equal(seededOffList.status, 200);
    assert.ok(seededOffList.data.requests.some((r: any) => r.request_no === 'OFF-202611-001'));

    const offCreate = await req('POST', '/api/hr-flows/offboarding', {
      token: newStaffToken,
      body: {
        employee_id: obComplete.data.employeeId,
        resign_reason_code: 'PERSONAL_DEV',
        resign_reason_detail: '个人职业发展原因申请离职',
        last_working_date: todayStr(),
        handover_notes: '已交接前厅钥匙与排班表',
      },
    });
    assert.equal(offCreate.status, 201);
    const offId = offCreate.data.request.id;

    // Duplicate active offboarding request is blocked
    const dupOff = await req('POST', '/api/hr-flows/offboarding', {
      token: newStaffToken,
      body: {
        employee_id: obComplete.data.employeeId,
        resign_reason_code: 'PERSONAL_DEV',
        resign_reason_detail: '重复申请',
        last_working_date: todayStr(),
      },
    });
    assert.equal(dupOff.status, 409);

    assert.equal((await req('POST', `/api/hr-flows/offboarding/${offId}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/hr-flows/offboarding/${offId}/action`, { token: hrToken, body: { action: 'APPROVE' } })).status, 200);

    const offComplete = await req('POST', `/api/hr-flows/offboarding/${offId}/complete`, {
      token: hrToken,
      body: { checklist: { work_handover: true, assets_returned: true, finance_settled: true } },
    });
    assert.equal(offComplete.status, 200);
    assert.ok(offComplete.data.archiveId);

    // Employee status is RESIGNED and login is disabled
    const empDetail = await req('GET', `/api/employees/${obComplete.data.employeeId}`, { token: hrToken });
    assert.equal(empDetail.status, 200);
    assert.equal(empDetail.data.employee.status, 'RESIGNED');
    assert.ok(empDetail.data.archive);

    const disabledLogin = await req('POST', '/api/auth/login', {
      body: { username: obComplete.data.username, password: 'Hotel@2026' },
    });
    assert.equal(disabledLogin.status, 401);

    // Full archived dossier contains lifecycle events and summary
    const archiveRes = await req('GET', `/api/hr-flows/archives/${obComplete.data.employeeId}`, { token: hrToken });
    assert.equal(archiveRes.status, 200);
    assert.equal(archiveRes.data.archive.employee_name, '林新宇');
    assert.ok(archiveRes.data.archive.records.lifecycleEvents.length >= 2);
  });

  it('T1-11: nowIso() and todayStr() format timestamps in Beijing time (UTC+8)', () => {
    const bjStr = nowIso();
    assert.match(bjStr, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const expectedBj = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const diffMs = Math.abs(Date.parse(bjStr.replace(' ', 'T') + 'Z') - Date.parse(expectedBj.replace(' ', 'T') + 'Z'));
    assert.ok(diffMs <= 5000, `Expected Beijing time ${expectedBj}, got ${bjStr}`);
  });

  it('T1-01: self-service password change, admin reset-password guard, and user management RBAC', async () => {
    const adminToken = await loginAs('admin');
    const staffToken = await loginAs('staff_sh');

    // STAFF cannot access /api/users
    assert.equal((await req('GET', '/api/users', { token: staffToken })).status, 403);

    // Admin cannot deactivate self
    const meRes = await req('GET', '/api/auth/me', { token: adminToken });
    const selfDisable = await req('PATCH', `/api/users/${meRes.data.user.id}/status`, {
      token: adminToken,
      body: { is_active: false },
    });
    assert.equal(selfDisable.status, 400);

    // Reset staff_hz password -> must_change_password = 1 -> blocked in prod mode until changed
    const usersRes = await req('GET', '/api/users', { token: adminToken });
    assert.equal(usersRes.status, 200);
    const staffHz = usersRes.data.users.find((u: any) => u.username === 'staff_hz');
    assert.ok(staffHz);

    const resetRes = await req('POST', `/api/users/${staffHz.id}/reset-password`, { token: adminToken });
    assert.equal(resetRes.status, 200);
    const tempPw = resetRes.data.temp_password;
    assert.ok(tempPw && tempPw.length >= 8);

    const prevDemo = process.env.DEMO_ROLE_SWITCH;
    process.env.DEMO_ROLE_SWITCH = 'false';
    try {
      const hzToken = await loginAs('staff_hz', tempPw);
      // Accessing non-auth API is blocked with 403 PASSWORD_CHANGE_REQUIRED
      const blockedDash = await req('GET', '/api/dashboard/summary', { token: hzToken });
      assert.equal(blockedDash.status, 403);

      // Change password succeeds, old temp password fails, new password works
      const chRes = await req('POST', '/api/auth/change-password', {
        token: hzToken,
        body: { old_password: tempPw, new_password: 'NewPass2026!' },
      });
      assert.equal(chRes.status, 200);

      const oldLogin = await req('POST', '/api/auth/login', {
        body: { username: 'staff_hz', password: tempPw },
      });
      assert.equal(oldLogin.status, 401);

      const newToken = await loginAs('staff_hz', 'NewPass2026!');
      const okDash = await req('GET', '/api/dashboard/summary', { token: newToken });
      assert.equal(okDash.status, 200);
    } finally {
      process.env.DEMO_ROLE_SWITCH = prevDemo;
    }
  });

  it('T1-07: unconfigured budget yields NO_BUDGET (not OVER_BUDGET), budget change requires reason, and new hotel copies template', async () => {
    const adminToken = await loginAs('admin');
    const finToken = await loginAs('finance');
    const ym = currentYearMonth();

    // 1. Create a new hotel WITHOUT budget template -> preview yields NO_BUDGET and NOT OVER_BUDGET
    const hNoBudget = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'NO-BUD-01',
        name: '无预算测试门店',
        region_id: 2,
        city: '上海市',
        address: '测试路100号',
        phone: '021-55556666',
        room_count: 80,
      },
    });
    assert.equal(hNoBudget.status, 201);
    const previewRes = await req('POST', '/api/reimbursements/preview', {
      token: adminToken,
      body: {
        hotel_id: hNoBudget.data.hotel.id,
        expense_month: ym,
        items: [{ category: 'LINEN_SUPPLIES', amount: 150 }],
      },
    });
    assert.equal(previewRes.status, 200);
    assert.ok(previewRes.data.risks.riskFlags.includes('NO_BUDGET'));
    assert.ok(!previewRes.data.risks.riskFlags.includes('OVER_BUDGET'));

    // 2. PUT /api/budgets without reason returns 400; with reason writes budget_change_logs
    const badUpd = await req('PUT', '/api/budgets', {
      token: finToken,
      body: { hotel_id: hNoBudget.data.hotel.id, year_month: ym, category: 'LINEN_SUPPLIES', budget_amount: 5000 },
    });
    assert.equal(badUpd.status, 400);

    const okUpd = await req('PUT', '/api/budgets', {
      token: finToken,
      body: {
        hotel_id: hNoBudget.data.hotel.id,
        year_month: ym,
        category: 'LINEN_SUPPLIES',
        budget_amount: 5000,
        reason: '新店开业初始化客房布草预算',
      },
    });
    assert.equal(okUpd.status, 200);

    const logsRes = await req('GET', `/api/budgets/logs?hotelId=${hNoBudget.data.hotel.id}`, { token: finToken });
    assert.equal(logsRes.status, 200);
    assert.ok(logsRes.data.logs.some((l: any) => l.reason === '新店开业初始化客房布草预算' && Number(l.new_amount) === 5000));

    // 3. Create a new hotel WITH budget_template_hotel_id = 2 -> copies budgets automatically
    const hWithTpl = await req('POST', '/api/organization/hotels', {
      token: adminToken,
      body: {
        code: 'TPL-BUD-02',
        name: '模板预算门店',
        region_id: 2,
        city: '上海市',
        address: '测试路200号',
        phone: '021-55557777',
        room_count: 100,
        budget_template_hotel_id: 2,
      },
    });
    assert.equal(hWithTpl.status, 201);
    const copiedBudgets = await req('GET', `/api/budgets?hotelId=${hWithTpl.data.hotel.id}&yearMonth=${ym}`, {
      token: finToken,
    });
    assert.equal(copiedBudgets.status, 200);
    assert.ok(copiedBudgets.data.budgets.length >= 5);
  });

  it('T1-02: concrete approver resolution, fallback escalation, delegation, and non-deadlock HR headcount', async () => {
    const adminToken = await loginAs('admin');
    const hrToken = await loginAs('hr');
    const gmToken = await loginAs('gm');
    const staffHzToken = await loginAs('staff_hz', 'NewPass2026!');
    const regionToken = await loginAs('region_east');
    const ym = currentYearMonth();

    // 1. HR submits headcount -> HR_MANAGER step auto-escalates to GENERAL_MANAGER (no deadlock)
    const hrHc = await req('POST', '/api/recruitment/headcounts', {
      token: hrToken,
      body: {
        hotel_id: 2,
        department_id: 5,
        position: '前厅接待专员',
        headcount: 1,
        salary_range: '5000-6500',
        reason: '测试HR提交补编不死锁',
      },
    });
    assert.equal(hrHc.status, 201);
    assert.equal((await req('POST', `/api/recruitment/headcounts/${hrHc.data.headcount.id}/action`, { token: regionToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/recruitment/headcounts/${hrHc.data.headcount.id}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status, 200);

    // 2. Delegation: region_east delegates to mgr_sz for today -> mgr_sz can approve a claim routed to region_east
    const usersRes = await req('GET', '/api/users', { token: adminToken });
    const mgrSzUser = usersRes.data.users.find((u: any) => u.username === 'mgr_sz');
    const mgrHzUser = usersRes.data.users.find((u: any) => u.username === 'mgr_hz');
    assert.ok(mgrSzUser && mgrHzUser);

    const delRes = await req('POST', '/api/users/delegations', {
      token: regionToken,
      body: {
        delegate_user_id: mgrSzUser.id,
        start_date: todayStr(),
        end_date: todayStr(),
        biz_types: 'REIMBURSEMENT',
      },
    });
    assert.equal(delRes.status, 201);

    // Disable mgr_hz temporarily -> staff_hz claim Step 1 escalates directly to REGIONAL_MANAGER (region_east)
    assert.equal((await req('PATCH', `/api/users/${mgrHzUser.id}/status`, { token: adminToken, body: { is_active: false } })).status, 200);
    try {
      const claimRes = await req('POST', '/api/reimbursements', {
        token: staffHzToken,
        body: {
          title: '店长缺位自动上推+委托审批测试',
          hotel_id: 3,
          expense_month: ym,
          payment_type: 'PERSONAL',
          payee_name: '方思琪',
          payee_bank: '招商银行杭州分行',
          payee_account: '6225880100003002',
          submit: true,
          items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '客耗品', amount: 150 }],
        },
      });
      assert.equal(claimRes.status, 201);
      // Delegated user mgr_sz can approve the escalated REGIONAL_MANAGER step!
      const mgrSzToken = await loginAs('mgr_sz');
      const delApprove = await req('POST', `/api/reimbursements/${claimRes.data.claim.id}/action`, {
        token: mgrSzToken,
        body: { action: 'APPROVE', comment: '代区域经理审批' },
      });
      assert.equal(delApprove.status, 200);

      // Delete delegation -> another user cannot approve
      assert.equal((await req('DELETE', `/api/users/delegations/${delRes.data.delegation.id}`, { token: regionToken })).status, 200);
    } finally {
      await req('PATCH', `/api/users/${mgrHzUser.id}/status`, { token: adminToken, body: { is_active: true } });
    }
  });

  it('T1-03: GM reimbursement routes to FINANCE/CHAIRMAN (never HQ_ADMIN) and GM leave auto-approves', async () => {
    const gmToken = await loginAs('gm');
    const finToken = await loginAs('finance');
    const ym = currentYearMonth();

    // 1. GM reimbursement routes to FINANCE (CHAIRMAN dropped with offline sign-off note when unconfigured)
    const gmClaim = await req('POST', '/api/reimbursements', {
      token: gmToken,
      body: {
        title: '总经理差旅费报销路由测试',
        hotel_id: 1,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '周志远',
        payee_bank: '招商银行上海分行',
        payee_account: '6225880100001001',
        submit: true,
        items: [{ category: 'TRAVEL_TRAINING', expense_date: todayStr(), description: '差旅', amount: 180 }],
      },
    });
    assert.equal(gmClaim.status, 201);
    const detail = await req('GET', `/api/reimbursements/${gmClaim.data.claim.id}`, { token: gmToken });
    assert.equal(detail.status, 200);
    assert.ok(!detail.data.approvalSteps.some((s: any) => s.approver_role === 'HQ_ADMIN'));
    assert.equal(detail.data.approvalSteps[0].approver_role, 'FINANCE');
    assert.equal((await req('POST', `/api/reimbursements/${gmClaim.data.claim.id}/action`, { token: finToken, body: { action: 'APPROVE' } })).status, 200);

    // 2. GM leave auto-approves immediately under filing mode
    const gmLeave = await req('POST', '/api/leaves', {
      token: gmToken,
      body: {
        leave_type: 'ANNUAL',
        start_date: todayStr(),
        end_date: todayStr(),
        days: 1,
        hours: 8,
        reason: '总经理年假备案测试',
      },
    });
    assert.equal(gmLeave.status, 201);
    assert.equal(gmLeave.data.leave.status, 'APPROVED');
  });

  it('T1-04/T1-05: reimbursement age/receipt/payee validation, payout segregation, and payment-failed retry', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrShToken = await loginAs('mgr_sh');
    const gmToken = await loginAs('gm');
    const finToken = await loginAs('finance');
    const ym = currentYearMonth();

    // 1. >= 200 without attachment -> 400
    const noAttach = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '缺附件测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '大额客耗品', amount: 300 }],
      },
    });
    assert.equal(noAttach.status, 400);

    // 2. External attachment URL -> 400
    const badAttach = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '非法附件URL测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [
          {
            category: 'LINEN_SUPPLIES',
            expense_date: todayStr(),
            description: '大额客耗品',
            amount: 300,
            attachment_url: 'https://evil.example.com/x.png',
          },
        ],
      },
    });
    assert.equal(badAttach.status, 400);

    // 3. Personal payee name mismatch -> 400
    const badPayee = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '收款人非本人测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '张三',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: todayStr(), description: '小额用品', amount: 120 }],
      },
    });
    assert.equal(badPayee.status, 400);

    // 4. Out-of-month item date -> 400
    const badDate = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '跨月日期测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [{ category: 'LINEN_SUPPLIES', expense_date: '2025-01-05', description: '过期单据', amount: 100 }],
      },
    });
    assert.equal(badDate.status, 400);

    // 5. Valid claim -> approve -> payment-failed -> applicant corrects payee -> retry payout succeeds
    const validClaim = await req('POST', '/api/reimbursements', {
      token: staffToken,
      body: {
        title: '付款失败重付闭环测试',
        hotel_id: 2,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行静安支行',
        payee_account: '6225880100002002',
        submit: true,
        items: [
          {
            category: 'LINEN_SUPPLIES',
            expense_date: todayStr(),
            description: '合规附件采购',
            amount: 260,
            attachment_url: '/seed-assets/invoice-sample-1.svg',
          },
        ],
      },
    });
    assert.equal(validClaim.status, 201);
    const cid = validClaim.data.claim.id;
    assert.equal((await req('POST', `/api/reimbursements/${cid}/action`, { token: mgrShToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/reimbursements/${cid}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status, 200);

    const failRes = await req('POST', `/api/reimbursements/${cid}/payment-failed`, {
      token: finToken,
      body: { reason: '开户行支行名称有误导致退票' },
    });
    assert.equal(failRes.status, 200);

    const fixPayee = await req('PATCH', `/api/reimbursements/${cid}/payee`, {
      token: staffToken,
      body: {
        payment_type: 'PERSONAL',
        payee_name: '陆子轩',
        payee_bank: '招商银行上海静安支行',
        payee_account: '6225880100002002',
      },
    });
    assert.equal(fixPayee.status, 200);

    const retryPayout = await req('POST', '/api/reimbursements/payout', {
      token: finToken,
      body: { reimbursement_ids: [cid], payment_channel: 'BANK_TRANSFER', payment_ref: 'TXN-RETRY-001' },
    });
    assert.equal(retryPayout.status, 200);

    // 6. Segregation: Finance cannot payout own reimbursement
    const finClaim = await req('POST', '/api/reimbursements', {
      token: finToken,
      body: {
        title: '财务本人报销不可自付测试',
        hotel_id: 1,
        expense_month: ym,
        payment_type: 'PERSONAL',
        payee_name: '陈明哲',
        payee_bank: '招商银行上海分行',
        payee_account: '6225880100001003',
        submit: true,
        items: [{ category: 'TRAVEL_TRAINING', expense_date: todayStr(), description: '市内交通', amount: 80 }],
      },
    });
    assert.equal(finClaim.status, 201);
    assert.equal((await req('POST', `/api/reimbursements/${finClaim.data.claim.id}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status, 200);
    const selfPayout = await req('POST', '/api/reimbursements/payout', {
      token: finToken,
      body: { reimbursement_ids: [finClaim.data.claim.id], payment_channel: 'BANK_TRANSFER', payment_ref: 'TXN-SELF-001' },
    });
    assert.equal(selfPayout.status, 403);
  });

  it('T1-06: cash advance payee, withdraw, return/resubmit, repayment, cap, and overdue guard', async () => {
    const staffToken = await loginAs('staff_sh');
    const mgrToken = await loginAs('mgr_sh');
    const finToken = await loginAs('finance');

    const tomorrow = (() => {
      const d = new Date(Date.now() + 8 * 3600 * 1000 + 86400 * 1000);
      return d.toISOString().slice(0, 10);
    })();
    const yesterday = (() => {
      const d = new Date(Date.now() + 8 * 3600 * 1000 - 86400 * 1000);
      return d.toISOString().slice(0, 10);
    })();

    // 1. Past expected_settle_date rejected; non-applicant payee rejected; exceeding 20k cap rejected
    const pastDateRes = await req('POST', '/api/advances', {
      token: staffToken,
      body: { hotel_id: 2, advance_type: 'TRAVEL', amount: 1000, purpose: '差旅借款', expected_settle_date: yesterday },
    });
    assert.equal(pastDateRes.status, 400);

    const wrongPayeeRes = await req('POST', '/api/advances', {
      token: staffToken,
      body: {
        hotel_id: 2,
        advance_type: 'TRAVEL',
        amount: 1000,
        purpose: '差旅借款',
        expected_settle_date: tomorrow,
        payee_name: '他人账户',
      },
    });
    assert.equal(wrongPayeeRes.status, 400);

    const overCapRes = await req('POST', '/api/advances', {
      token: staffToken,
      body: { hotel_id: 2, advance_type: 'PETTY_CASH', amount: 25000, purpose: '超限借款', expected_settle_date: tomorrow },
    });
    assert.equal(overCapRes.status, 400);

    // 2. Withdraw flow
    const advW = await req('POST', '/api/advances', {
      token: staffToken,
      body: { hotel_id: 2, advance_type: 'TRAVEL', amount: 800, purpose: '可撤回借款', expected_settle_date: tomorrow },
    });
    assert.equal(advW.status, 201);
    const wId = advW.data.advance.id;
    assert.equal((await req('POST', `/api/advances/${wId}/withdraw`, { token: mgrToken })).status, 403);
    assert.equal((await req('POST', `/api/advances/${wId}/withdraw`, { token: staffToken })).status, 200);
    assert.equal((await req('POST', `/api/advances/${wId}/withdraw`, { token: staffToken })).status, 400);

    // 3. Return -> edit/resubmit -> approve -> disburse -> partial repay -> full repay -> SETTLED
    const advMain = await req('POST', '/api/advances', {
      token: staffToken,
      body: {
        hotel_id: 2,
        advance_type: 'PETTY_CASH',
        amount: 1200,
        purpose: '客耗品备用金',
        expected_settle_date: tomorrow,
        payee_bank: '招商银行上海静安支行',
        payee_account: '6225880100002002',
      },
    });
    assert.equal(advMain.status, 201);
    const advId = advMain.data.advance.id;

    assert.equal(
      (await req('POST', `/api/advances/${advId}/action`, { token: mgrToken, body: { action: 'RETURN', comment: '金额调整' } })).status,
      200
    );
    const editRes = await req('PUT', `/api/advances/${advId}`, {
      token: staffToken,
      body: {
        hotel_id: 2,
        advance_type: 'PETTY_CASH',
        amount: 1000,
        purpose: '客耗品备用金（核减）',
        expected_settle_date: tomorrow,
        payee_bank: '招商银行上海静安支行',
        payee_account: '6225880100002002',
      },
    });
    assert.equal(editRes.status, 200);
    assert.equal((await req('POST', `/api/advances/${advId}/action`, { token: mgrToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/advances/${advId}/action`, { token: finToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal(
      (await req('POST', `/api/advances/${advId}/disburse`, { token: finToken, body: { payment_ref: 'ADV-DISB-T106' } })).status,
      200
    );

    // Non-finance cannot record repayment
    assert.equal(
      (await req('POST', `/api/advances/${advId}/repay`, { token: staffToken, body: { amount: 400, repayment_method: 'CASH' } })).status,
      403
    );

    const repay1 = await req('POST', `/api/advances/${advId}/repay`, {
      token: finToken,
      body: { amount: 400, repayment_method: 'BANK_TRANSFER', payment_ref: 'REP-001' },
    });
    assert.equal(repay1.status, 200);
    assert.equal(repay1.data.status, 'DISBURSED');

    const repay2 = await req('POST', `/api/advances/${advId}/repay`, {
      token: finToken,
      body: { amount: 600, repayment_method: 'CASH', remark: '现金结清' },
    });
    assert.equal(repay2.status, 200);
    assert.equal(repay2.data.status, 'SETTLED');

    const repList = await req('GET', `/api/advances/${advId}/repayments`, { token: staffToken });
    assert.equal(repList.status, 200);
    assert.equal(repList.data.repayments.length, 2);
  });

  it('T1-09a: payroll proration for mid-month hire/resign, deductions, and terminal lock', async () => {
    const hrToken = await loginAs('hr');
    const finToken = await loginAs('finance');
    const staffToken = await loginAs('staff_sh');

    const ym = '2026-06'; // 30 days
    // 1. Create a mid-month hire employee (hire_date 2026-06-16 => 15 days => 50% of 6000 = 3000)
    const hireRes = await req('POST', '/api/employees', {
      token: hrToken,
      body: {
        name: '折算测试员工',
        gender: 'M',
        phone: '13900001091',
        hotel_id: 2,
        department_id: 6,
        position: '前厅接待员',
        employment_type: 'FULL_TIME',
        status: 'ACTIVE',
        hire_date: '2026-06-16',
        base_salary: 6000,
      },
    });
    assert.equal(hireRes.status, 201);
    const midEmpId = hireRes.data.employee.id;

    // 2. Create and resign another employee mid-month (2026-06-15 => 15 days => 50% of 4000 = 2000)
    const resignEmpRes = await req('POST', '/api/employees', {
      token: hrToken,
      body: {
        name: '当月离职员工',
        gender: 'F',
        phone: '13900001092',
        hotel_id: 2,
        department_id: 6,
        position: '客房服务员',
        employment_type: 'FULL_TIME',
        status: 'ACTIVE',
        hire_date: '2026-01-01',
        base_salary: 4000,
      },
    });
    assert.equal(resignEmpRes.status, 201);
    const resEmpId = resignEmpRes.data.employee.id;

    const resignLife = await req('POST', `/api/employees/${resEmpId}/lifecycle`, {
      token: hrToken,
      body: {
        event_type: 'RESIGN',
        effective_date: '2026-06-15',
        reason: '个人原因离职',
      },
    });
    assert.equal(resignLife.status, 200);

    // 3. Calculate payroll for 2026-06 on hotel 2
    const calcRes = await req('POST', '/api/payroll/calculate', {
      token: hrToken,
      body: { yearMonth: ym, hotelId: 2 },
    });
    assert.equal(calcRes.status, 200);

    const listRes = await req('GET', `/api/payroll?yearMonth=${ym}&hotelId=2`, { token: finToken });
    assert.equal(listRes.status, 200);
    const midRec = listRes.data.records.find((r: any) => r.employee_id === midEmpId);
    const resRec = listRes.data.records.find((r: any) => r.employee_id === resEmpId);
    assert.ok(midRec);
    assert.ok(resRec);
    assert.equal(midRec.prorated_days, 15);
    assert.equal(midRec.base_salary, 3000);
    assert.equal(resRec.prorated_days, 15);
    assert.equal(resRec.base_salary, 2000);
    assert.equal(resRec.is_resigned_settlement, 1);

    // 4. Unauthorized staff cannot edit payroll; finance can add allowance & deductions
    assert.equal(
      (await req('PUT', `/api/payroll/${midRec.id}`, { token: staffToken, body: { performance_bonus: 500 } })).status,
      403
    );
    const updRes = await req('PUT', `/api/payroll/${midRec.id}`, {
      token: finToken,
      body: { performance_bonus: 500, other_allowance: 200, advance_deduction: 300, other_deduction: 100 },
    });
    assert.equal(updRes.status, 200);
    // gross = 3000 + 500 + 200 = 3700; net = max(0, gross - ss - tax - 300 - 100)
    assert.equal(updRes.data.record.gross_pay, 3700);
    const expectedNet = Math.max(
      0,
      Math.round(
        (updRes.data.record.gross_pay -
          updRes.data.record.social_security -
          (updRes.data.record.income_tax || 0) -
          300 -
          100) *
          100
      ) / 100
    );
    assert.equal(updRes.data.record.net_pay, expectedNet);

    // 5. Confirm lock prevents further edits
    assert.equal((await req('POST', '/api/payroll/confirm', { token: finToken, body: { yearMonth: ym, hotelId: 2 } })).status, 200);
    assert.equal(
      (await req('PUT', `/api/payroll/${midRec.id}`, { token: finToken, body: { performance_bonus: 600 } })).status,
      400
    );
  });

  it('T1-08: offboarding clearance checklist, advance block/salary-deduct, and scheduled execution', async () => {
    const hrToken = await loginAs('hr');
    const mgrToken = await loginAs('mgr_sh');
    const finToken = await loginAs('finance');
    const gmToken = await loginAs('gm');

    const tomorrow = (() => {
      const d = new Date(Date.now() + 8 * 3600 * 1000 + 86400 * 1000);
      return d.toISOString().slice(0, 10);
    })();
    const today = (() => {
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      return d.toISOString().slice(0, 10);
    })();

    // 1. Onboard an employee with a user account and give them a disbursed advance
    const obCreate = await req('POST', '/api/hr-flows/onboarding', {
      token: hrToken,
      body: {
        candidate_name: '离职清查测试员',
        gender: 'M',
        phone: '13900001081',
        hotel_id: 2,
        department_id: 6,
        position: '前厅接待员',
        planned_hire_date: today,
        base_salary: 5000,
        create_user_account: true,
      },
    });
    assert.equal(obCreate.status, 201);
    const obId = obCreate.data.request.id;
    assert.equal((await req('POST', `/api/hr-flows/onboarding/${obId}/action`, { token: gmToken, body: { action: 'APPROVE' } })).status, 200);
    const obComp = await req('POST', `/api/hr-flows/onboarding/${obId}/complete`, { token: hrToken, body: {} });
    assert.equal(obComp.status, 200);
    const empId = obComp.data.employeeId;
    const empUserToken = await loginAs(obComp.data.username, obComp.data.temp_password);

    // Change password first (production guard check skipped in demo mode, or just apply advance directly in demo mode)
    const advRes = await req('POST', '/api/advances', {
      token: empUserToken,
      body: { hotel_id: 2, advance_type: 'TRAVEL', amount: 500, purpose: '差旅借款', expected_settle_date: tomorrow },
    });
    assert.equal(advRes.status, 201);
    const advId = advRes.data.advance.id;
    assert.equal((await req('POST', `/api/advances/${advId}/action`, { token: mgrToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/advances/${advId}/action`, { token: finToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/advances/${advId}/disburse`, { token: finToken, body: { payment_ref: 'ADV-T108' } })).status, 200);

    // 2. Submit offboarding by employee -> clearance items generated with ADVANCE_SETTLE = BLOCKED
    const offRes = await req('POST', '/api/hr-flows/offboarding', {
      token: empUserToken,
      body: {
        employee_id: empId,
        resign_reason_code: 'PERSONAL',
        resign_reason_detail: '个人发展原因离职',
        last_working_date: tomorrow,
      },
    });
    assert.equal(offRes.status, 201);
    const offId = offRes.data.request.id;
    assert.equal(offRes.data.request.unsettled_advance_amount, 500);

    const clearList = await req('GET', `/api/hr-flows/offboarding/${offId}/clearance`, { token: finToken });
    assert.equal(clearList.status, 200);
    assert.equal(clearList.data.items.length, 4);
    const advClearItem = clearList.data.items.find((x: any) => x.item_key === 'ADVANCE_SETTLE');
    assert.equal(advClearItem.status, 'BLOCKED');

    // Approve offboarding steps
    assert.equal((await req('POST', `/api/hr-flows/offboarding/${offId}/action`, { token: mgrToken, body: { action: 'APPROVE' } })).status, 200);
    assert.equal((await req('POST', `/api/hr-flows/offboarding/${offId}/action`, { token: hrToken, body: { action: 'APPROVE' } })).status, 200);

    // 3. Cannot complete while ADVANCE_SETTLE is BLOCKED or without allow_salary_deduct
    const blockedComp = await req('POST', `/api/hr-flows/offboarding/${offId}/complete`, { token: hrToken, body: {} });
    assert.equal(blockedComp.status, 400);

    // Cannot clear ADVANCE_SETTLE without allow_salary_deduct while advance is still open
    const failClear = await req('POST', `/api/hr-flows/offboarding/${offId}/clearance/${advClearItem.id}`, {
      token: finToken,
      body: { status: 'CLEARED' },
    });
    assert.equal(failClear.status, 400);

    // Clear with allow_salary_deduct = true
    const okClear = await req('POST', `/api/hr-flows/offboarding/${offId}/clearance/${advClearItem.id}`, {
      token: finToken,
      body: { status: 'CLEARED', allow_salary_deduct: true, remark: '同意离职薪资扣回 500 元' },
    });
    assert.equal(okClear.status, 200);

    // 4. Schedule for effective date (tomorrow) -> remains APPROVED with scheduled_execute = 1
    const schedRes = await req('POST', `/api/hr-flows/offboarding/${offId}/complete`, {
      token: hrToken,
      body: { schedule_for_effective_date: true, allow_salary_deduct: true },
    });
    assert.equal(schedRes.status, 200);
    assert.equal(schedRes.data.scheduled, true);

    // Unauthorized staff cannot trigger run-scheduled
    assert.equal((await req('POST', '/api/hr-flows/offboarding/run-scheduled', { token: empUserToken })).status, 403);

    // Immediate complete works once clearance is unblocked
    const compNow = await req('POST', `/api/hr-flows/offboarding/${offId}/complete`, {
      token: hrToken,
      body: { allow_salary_deduct: true },
    });
    assert.equal(compNow.status, 200);
    assert.ok(compNow.data.archiveId > 0);
  });

  it('T1-09b: city social security clamping, cumulative IIT withholding, special deduction, and RBAC', async () => {
    const hrToken = await loginAs('hr');
    const finToken = await loginAs('finance');
    const staffToken = await loginAs('staff_sh');

    // 1. Staff cannot update city social security rules -> 403
    assert.equal(
      (
        await req('PUT', '/api/payroll/ss-rules', {
          token: staffToken,
          body: {
            city: '苏州',
            ss_base_min: 4800,
            ss_base_max: 24000,
            pension_rate: 0.08,
            medical_rate: 0.02,
            unemployment_rate: 0.005,
            housing_fund_rate: 0.07,
          },
        })
      ).status,
      403
    );

    const rulesRes = await req('GET', '/api/payroll/ss-rules', { token: finToken });
    assert.equal(rulesRes.status, 200);
    assert.ok(rulesRes.data.rules.some((r: any) => r.city === '上海'));

    // 2. Create an employee in Shanghai (ss_base_min=7384, rate=17.5%) with base_salary 10000 and special_additional_deduction 1000
    const empRes = await req('POST', '/api/employees', {
      token: hrToken,
      body: {
        name: '个税测试员工',
        gender: 'M',
        phone: '13900001095',
        hotel_id: 2,
        department_id: 6,
        position: '前厅主管',
        employment_type: 'FULL_TIME',
        status: 'ACTIVE',
        hire_date: '2026-01-01',
        base_salary: 10000,
      },
    });
    assert.equal(empRes.status, 201);
    const empId = empRes.data.employee.id;

    assert.equal(
      (await req('PUT', `/api/employees/${empId}`, { token: hrToken, body: { special_additional_deduction: 1000 } })).status,
      200
    );

    // Month 1 (2026-01): gross=10000, ss=10000*0.175=1750, spec=1000, threshold=5000 => taxable = 2250 => tax = 2250*0.03 = 67.50
    assert.equal((await req('POST', '/api/payroll/calculate', { token: hrToken, body: { yearMonth: '2026-01', hotelId: 2 } })).status, 200);
    const janList = await req('GET', '/api/payroll?yearMonth=2026-01&hotelId=2', { token: finToken });
    const janRec = janList.data.records.find((r: any) => r.employee_id === empId);
    assert.ok(janRec);
    assert.equal(janRec.social_security, 1750);
    assert.equal(janRec.special_deduction, 1000);
    assert.equal(janRec.income_tax, 67.5);

    // Month 2 (2026-02) with big bonus pushing YTD taxable over 36,000 bracket
    assert.equal((await req('POST', '/api/payroll/calculate', { token: hrToken, body: { yearMonth: '2026-02', hotelId: 2 } })).status, 200);
    const febList = await req('GET', '/api/payroll?yearMonth=2026-02&hotelId=2', { token: finToken });
    const febRec = febList.data.records.find((r: any) => r.employee_id === empId);
    const febUpd = await req('PUT', `/api/payroll/${febRec.id}`, {
      token: finToken,
      body: { performance_bonus: 35000 },
    });
    assert.equal(febUpd.status, 200);
    // YTD taxable = (10000 + 45000) - 3500 - 2000 - 10000 = 39500 (> 36000 => 10% rate, quickDeduction 2520)
    // Cumulative tax = 39500*0.1 - 2520 = 1430; Feb tax = 1430 - 67.5 = 1362.5
    assert.equal(febUpd.data.record.ytd_taxable_income, 39500);
    assert.equal(febUpd.data.record.income_tax, 1362.5);
  });
});
