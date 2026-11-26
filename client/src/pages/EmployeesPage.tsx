import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, FileText, Plus, Search, UserCheck, UserCog, UserMinus, XCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney, todayStr } from '../lib/format';

interface EmployeeRow {
  id: number;
  emp_no: string;
  name: string;
  gender: string;
  phone: string;
  hotel_id: number;
  hotel_name: string;
  department_id: number;
  department_name: string;
  position: string;
  education?: string | null;
  marital_status?: string | null;
  political_status?: string | null;
  employment_type?: string;
  status: string;
  hire_date: string;
  contract_end_date: string | null;
  health_cert_expiry: string | null;
  base_salary: number;
}

interface LifecycleEvent {
  id: number;
  event_type: string;
  from_hotel_name: string | null;
  to_hotel_name: string | null;
  from_position: string | null;
  to_position: string | null;
  effective_date: string;
  reason: string;
  operator_name: string | null;
}

interface OnboardingRequestRow {
  id: number;
  request_no: string;
  candidate_name: string;
  gender: string;
  phone: string;
  hotel_id: number;
  hotel_name: string;
  department_id: number;
  department_name: string;
  position: string;
  planned_hire_date: string;
  base_salary: number;
  status: string;
  status_detail?: string;
  applicant_name: string;
  employee_id: number | null;
  remarks: string | null;
  canApprove?: boolean;
  canComplete?: boolean;
}

interface OffboardingRequestRow {
  id: number;
  request_no: string;
  employee_id: number;
  employee_name: string;
  emp_no: string;
  employee_position: string;
  hotel_id: number;
  hotel_name: string;
  department_name: string;
  resign_reason_code: string;
  resign_reason_detail: string;
  last_working_date: string;
  handover_to_name: string | null;
  handover_notes: string | null;
  unsettled_advances: number;
  status: string;
  status_detail?: string;
  applicant_name: string;
  archive_id: number | null;
  canApprove?: boolean;
  canComplete?: boolean;
}

interface ArchiveListRow {
  id: number;
  employee_id: number;
  emp_no: string;
  employee_name: string;
  hotel_name: string;
  department_name: string;
  position: string;
  hire_date: string;
  resign_date: string;
  resign_reason: string;
  summary: Record<string, number>;
  archived_by_name: string;
  archived_at: string;
}

interface ArchiveDetail {
  id: number;
  employee_id: number;
  emp_no: string;
  employee_name: string;
  hotel_name: string;
  department_name: string;
  position: string;
  hire_date: string;
  resign_date: string;
  resign_reason: string;
  archived_by_name: string;
  archived_at: string;
  snapshot: Record<string, unknown>;
  summary: Record<string, number>;
  records: {
    lifecycleEvents?: any[];
    reimbursements?: any[];
    cashAdvances?: any[];
    leaveRequests?: any[];
    payrollRecords?: any[];
    shiftSchedules?: any[];
  };
}

const EVENT_LABELS: Record<string, string> = {
  ONBOARD: '入职建档',
  CONFIRM: '转正',
  TRANSFER: '跨店/部门调动',
  PROMOTE: '晋升调岗',
  RESIGN: '离职办理',
};

export function EmployeesPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canManage = ['HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'].includes(
    user?.role || ''
  );

  const [mainTab, setMainTab] = useState<'roster' | 'onboarding' | 'offboarding' | 'archives'>('roster');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE_ONLY' | 'RESIGNED'>('ALL');
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [onboardingList, setOnboardingList] = useState<OnboardingRequestRow[]>([]);
  const [offboardingList, setOffboardingList] = useState<OffboardingRequestRow[]>([]);
  const [archives, setArchives] = useState<ArchiveListRow[]>([]);
  const [archiveDetail, setArchiveDetail] = useState<ArchiveDetail | null>(null);
  const [hotels, setHotels] = useState<Array<{ id: number; name: string; is_hq?: number }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; hotel_id: number; code: string; name: string }>>([]);
  const [deptTemplates, setDeptTemplates] = useState<Array<{ id: number; org_level: string; code: string; name: string }>>([]);
  const [jobPositions, setJobPositions] = useState<Array<{ id: number; org_level: string; dept_template_id: number; name: string }>>([]);
  const [dicts, setDicts] = useState<Record<string, Array<{ code: string; label: string }>>>({});

  const [keyword, setKeyword] = useState('');
  const [alertType, setAlertType] = useState('');

  // Detail & lifecycle
  const [selected, setSelected] = useState<{ employee: EmployeeRow; events: LifecycleEvent[]; archive?: any } | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lcType, setLcType] = useState<'CONFIRM' | 'TRANSFER' | 'PROMOTE' | 'RESIGN'>('TRANSFER');
  const [lcHotelId, setLcHotelId] = useState<number>(0);
  const [lcDeptId, setLcDeptId] = useState<number>(1);
  const [lcPos, setLcPos] = useState('');
  const [lcReason, setLcReason] = useState('');

  // Onboard modal (also used for submitting onboarding workflow)
  const [createOpen, setCreateOpen] = useState(false);
  const [cMode, setCMode] = useState<'direct' | 'workflow'>('workflow');
  const [cName, setCName] = useState('');
  const [cGender, setCGender] = useState('M');
  const [cPhone, setCPhone] = useState('');
  const [cHotelId, setCHotelId] = useState<number>(user?.hotel_id || 0);
  const [cDeptId, setCDeptId] = useState<number>(1);
  const [cPositionId, setCPositionId] = useState<number>(0);
  const [cPos, setCPos] = useState('前台接待员');
  const [cEducation, setCEducation] = useState('BACHELOR');
  const [cEmploymentType, setCEmploymentType] = useState('FULL_TIME');
  const [cMaritalStatus, setCMaritalStatus] = useState('SINGLE');
  const [cPoliticalStatus, setCPoliticalStatus] = useState('MASSES');
  const [cSalary, setCSalary] = useState(6500);
  const [cPlannedDate, setCPlannedDate] = useState(todayStr());
  const [cHealthExpiry, setCHealthExpiry] = useState('');
  const [cRemarks, setCRemarks] = useState('');

  // Offboarding modal
  const [offOpen, setOffOpen] = useState(false);
  const [offEmpId, setOffEmpId] = useState<number>(user?.employee_id || 0);
  const [offReasonCode, setOffReasonCode] = useState('PERSONAL_DEV');
  const [offReasonDetail, setOffReasonDetail] = useState('');
  const [offLastDate, setOffLastDate] = useState(todayStr());
  const [offHandoverEmpId, setOffHandoverEmpId] = useState<number>(0);
  const [offHandoverNotes, setOffHandoverNotes] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (keyword.trim()) params.set('keyword', keyword.trim());
    if (alertType) params.set('alertType', alertType);
    if (statusFilter === 'RESIGNED') params.set('status', 'RESIGNED');
    const [empRes, obRes, offRes, archRes] = await Promise.all([
      apiFetch<{ employees: EmployeeRow[] }>(`/api/employees?${params.toString()}`),
      apiFetch<{ requests: OnboardingRequestRow[] }>('/api/hr-flows/onboarding').catch(() => ({ requests: [] })),
      apiFetch<{ requests: OffboardingRequestRow[] }>('/api/hr-flows/offboarding').catch(() => ({ requests: [] })),
      apiFetch<{ archives: ArchiveListRow[] }>('/api/hr-flows/archives').catch(() => ({ archives: [] })),
    ]);
    const list =
      statusFilter === 'ACTIVE_ONLY'
        ? empRes.employees.filter((e) => e.status !== 'RESIGNED')
        : empRes.employees;
    setEmployees(list);
    setOnboardingList(obRes.requests);
    setOffboardingList(offRes.requests);
    setArchives(archRes.archives);
  }, [keyword, alertType, statusFilter]);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  useEffect(() => {
    apiFetch<{
      hotels: Array<{ id: number; name: string; is_hq?: number }>;
      departments: Array<{ id: number; hotel_id: number; code: string; name: string }>;
    }>('/api/organization/hotels?all=true').then((d) => {
      setHotels(d.hotels);
      setDepartments(d.departments);
      const hid = user?.hotel_id || d.hotels[0]?.id || 0;
      setCHotelId(hid);
      const firstDept = d.departments.find((x) => x.hotel_id === hid);
      if (firstDept) setCDeptId(firstDept.id);
    });
    apiFetch<{
      deptTemplates: Array<{ id: number; org_level: string; code: string; name: string }>;
      jobPositions: Array<{ id: number; org_level: string; dept_template_id: number; name: string }>;
      dicts: Record<string, Array<{ code: string; label: string }>>;
    }>('/api/master-data/options')
      .then((md) => {
        setDeptTemplates(md.deptTemplates || []);
        setJobPositions(md.jobPositions || []);
        setDicts(md.dicts || {});
      })
      .catch(() => {});
  }, [user?.hotel_id]);

  const openDetail = async (id: number) => {
    const d = await apiFetch<{ employee: EmployeeRow; events: LifecycleEvent[]; archive?: any }>(`/api/employees/${id}`);
    setSelected(d);
    setLcHotelId(d.employee.hotel_id);
    setLcDeptId(d.employee.department_id);
    setLcPos(d.employee.position);
  };

  const openArchiveDossier = async (employeeId: number) => {
    try {
      const d = await apiFetch<{ archive: ArchiveDetail }>(`/api/hr-flows/archives/${employeeId}`);
      setArchiveDetail(d.archive);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载归档档案失败', 'error');
    }
  };

  const handleOnboard = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (cMode === 'workflow') {
        await apiFetch('/api/hr-flows/onboarding', {
          method: 'POST',
          body: JSON.stringify({
            candidate_name: cName,
            gender: cGender,
            phone: cPhone,
            hotel_id: cHotelId,
            department_id: cDeptId,
            position_id: cPositionId || null,
            position: cPos,
            education: cEducation || null,
            employment_type: cEmploymentType,
            marital_status: cMaritalStatus || null,
            political_status: cPoliticalStatus || null,
            planned_hire_date: cPlannedDate || todayStr(),
            base_salary: Number(cSalary),
            health_cert_expiry: cHealthExpiry || null,
            create_user_account: true,
            remarks: cRemarks || null,
          }),
        });
        showToast('入职审批申请已提交');
        setMainTab('onboarding');
      } else {
        await apiFetch('/api/employees', {
          method: 'POST',
          body: JSON.stringify({
            name: cName,
            gender: cGender,
            phone: cPhone,
            hotel_id: cHotelId,
            department_id: cDeptId,
            position_id: cPositionId || null,
            position: cPos,
            education: cEducation || null,
            employment_type: cEmploymentType,
            marital_status: cMaritalStatus || null,
            political_status: cPoliticalStatus || null,
            base_salary: Number(cSalary),
            health_cert_expiry: cHealthExpiry || null,
            hire_date: cPlannedDate || todayStr(),
          }),
        });
        showToast('员工入职建档成功');
      }
      setCreateOpen(false);
      setCName('');
      setCPhone('');
      setCRemarks('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const handleFlowAction = async (kind: 'onboarding' | 'offboarding', id: number, action: 'APPROVE' | 'REJECT') => {
    try {
      await apiFetch(`/api/hr-flows/${kind}/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      showToast(action === 'APPROVE' ? '已审批通过' : '已驳回申请');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '审批失败', 'error');
    }
  };

  const handleCompleteOnboarding = async (id: number) => {
    try {
      const res = await apiFetch<{ empNo: string; username: string | null }>(`/api/hr-flows/onboarding/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ checklist: { contract_signed: true, badge_issued: true } }),
      });
      showToast(`入职建档完成（工号 ${res.empNo}${res.username ? `，账号 ${res.username}` : ''}）`);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '办结失败', 'error');
    }
  };

  const handleSubmitOffboarding = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/hr-flows/offboarding', {
        method: 'POST',
        body: JSON.stringify({
          employee_id: offEmpId,
          resign_reason_code: offReasonCode,
          resign_reason_detail: offReasonDetail,
          last_working_date: offLastDate,
          handover_to_employee_id: offHandoverEmpId || null,
          handover_notes: offHandoverNotes || null,
        }),
      });
      showToast('离职审批申请已提交');
      setOffOpen(false);
      setOffReasonDetail('');
      setOffHandoverNotes('');
      setMainTab('offboarding');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交离职申请失败', 'error');
    }
  };

  const handleCompleteOffboarding = async (id: number) => {
    if (!window.confirm('确认办结离职？员工状态将变为「已离职」，登录账号停用，所有历史记录将归档。')) return;
    try {
      await apiFetch(`/api/hr-flows/offboarding/${id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ checklist: { work_handover: true, assets_returned: true, finance_settled: true } }),
      });
      showToast('离职手续已办结，人员状态已更新为「已离职」并完成档案归档');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '办结离职失败', 'error');
    }
  };

  const handleLifecycle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    try {
      await apiFetch(`/api/employees/${selected.employee.id}/lifecycle`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: lcType,
          to_hotel_id: lcHotelId,
          to_department_id: lcDeptId,
          to_position: lcPos,
          reason: lcReason,
          effective_date: todayStr(),
        }),
      });
      showToast('人事变动已生效并记入档案');
      setLifecycleOpen(false);
      setLcReason('');
      await openDetail(selected.employee.id);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const today = todayStr();

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">员工档案与入离职管理</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            覆盖入职审批建档、转正调动、离职交接审批与离职后历史档案归档
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => {
              setOffEmpId(user?.employee_id || employees.find((e) => e.status !== 'RESIGNED')?.id || 0);
              setOffOpen(true);
            }}
            className="px-3.5 py-2 rounded-xl border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 text-sm font-semibold flex items-center gap-1.5"
          >
            <UserMinus className="w-4 h-4 text-rose-600" /> 发起离职申请
          </button>
          {canManage && (
            <button
              onClick={() => {
                setCMode('workflow');
                setCreateOpen(true);
              }}
              className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" /> 发起入职 / 建档
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit flex-wrap">
        {[
          { key: 'roster', label: `员工花名册 (${employees.length})`, icon: <UserCheck className="w-3.5 h-3.5" /> },
          {
            key: 'onboarding',
            label: `入职流程 (${onboardingList.filter((x) => x.status === 'PENDING_APPROVAL' || x.status === 'APPROVED').length})`,
            icon: <Plus className="w-3.5 h-3.5" />,
          },
          {
            key: 'offboarding',
            label: `离职流程 (${offboardingList.filter((x) => x.status === 'PENDING_APPROVAL' || x.status === 'APPROVED').length})`,
            icon: <UserMinus className="w-3.5 h-3.5" />,
          },
          { key: 'archives', label: `离职归档库 (${archives.length})`, icon: <Archive className="w-3.5 h-3.5" /> },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setMainTab(t.key as typeof mainTab)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
              mainTab === t.key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {mainTab === 'roster' && (
        <>
          <div className="bg-white rounded-2xl border border-stone-200/90 p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl">
                {[
                  { key: 'ALL', label: '全部状态' },
                  { key: 'ACTIVE_ONLY', label: '在职/试用' },
                  { key: 'RESIGNED', label: '已离职' },
                ].map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStatusFilter(s.key as typeof statusFilter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                      statusFilter === s.key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl">
                {[
                  { key: '', label: '全部合规项' },
                  { key: 'health_cert', label: '健康证到期预警' },
                  { key: 'contract', label: '合同到期预警' },
                ].map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setAlertType(t.key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${
                      alertType === t.key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              <Search className="w-4 h-4 text-stone-400 absolute left-3 top-2.5" />
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜姓名 / 工号 / 岗位"
                className="pl-9 pr-3 py-1.5 rounded-xl border border-stone-200 text-sm w-56"
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                  <tr>
                    <th className="px-5 py-3.5">工号 / 姓名</th>
                    <th className="px-4 py-3.5">所属门店 / 部门</th>
                    <th className="px-4 py-3.5">岗位</th>
                    <th className="px-4 py-3.5">状态</th>
                    <th className="px-4 py-3.5">健康证到期</th>
                    <th className="px-4 py-3.5">合同到期</th>
                    <th className="px-5 py-3.5 text-right">底薪</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {employees.map((e) => {
                    const healthExpired = e.health_cert_expiry && e.health_cert_expiry < today;
                    return (
                      <tr
                        key={e.id}
                        onClick={() => openDetail(e.id)}
                        className="hover:bg-stone-50/80 cursor-pointer"
                      >
                        <td className="px-5 py-3.5">
                          <div className="font-semibold text-stone-900">{e.name}</div>
                          <div className="text-xs text-stone-400 font-mono">{e.emp_no}</div>
                        </td>
                        <td className="px-4 py-3.5">
                          <div>{e.hotel_name}</div>
                          <div className="text-xs text-stone-500">{e.department_name}</div>
                        </td>
                        <td className="px-4 py-3.5 text-stone-700">{e.position}</td>
                        <td className="px-4 py-3.5">
                          <StatusBadge status={e.status} />
                        </td>
                        <td className="px-4 py-3.5 text-xs tabular-nums">
                          {e.health_cert_expiry ? (
                            <span className={healthExpired ? 'text-rose-600 font-semibold flex items-center gap-1' : 'text-stone-700'}>
                              {healthExpired && <AlertTriangle className="w-3.5 h-3.5" />}
                              {e.health_cert_expiry}
                            </span>
                          ) : (
                            <span className="text-stone-400">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-xs tabular-nums text-stone-700">
                          {e.contract_end_date || '-'}
                        </td>
                        <td className="px-5 py-3.5 text-right font-semibold tabular-nums">
                          {formatMoney(e.base_salary)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {mainTab === 'onboarding' && (
        <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                <tr>
                  <th className="px-5 py-3.5">单号 / 拟入职人员</th>
                  <th className="px-4 py-3.5">门店 / 部门 / 岗位</th>
                  <th className="px-4 py-3.5">拟入职日期</th>
                  <th className="px-4 py-3.5">月底薪</th>
                  <th className="px-4 py-3.5">流程状态</th>
                  <th className="px-5 py-3.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {onboardingList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-stone-400">
                      暂无入职审批申请
                    </td>
                  </tr>
                ) : (
                  onboardingList.map((r) => (
                    <tr key={r.id} className="hover:bg-stone-50/70">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-stone-900">{r.candidate_name}</div>
                        <div className="text-xs text-stone-400 font-mono">{r.request_no} · {r.phone}</div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div>{r.hotel_name}</div>
                        <div className="text-xs text-stone-500">{r.department_name} · {r.position}</div>
                      </td>
                      <td className="px-4 py-3.5 text-xs tabular-nums">{r.planned_hire_date}</td>
                      <td className="px-4 py-3.5 text-xs font-semibold tabular-nums">{formatMoney(r.base_salary)}</td>
                      <td className="px-4 py-3.5">
                        <StatusBadge status={r.status} />
                        {r.status_detail && <div className="text-[11px] text-stone-400 mt-0.5">{r.status_detail}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-right space-x-2">
                        {r.canApprove && (
                          <>
                            <button
                              onClick={() => handleFlowAction('onboarding', r.id, 'APPROVE')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> 同意
                            </button>
                            <button
                              onClick={() => handleFlowAction('onboarding', r.id, 'REJECT')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-medium"
                            >
                              <XCircle className="w-3.5 h-3.5" /> 驳回
                            </button>
                          </>
                        )}
                        {r.canComplete && (
                          <button
                            onClick={() => handleCompleteOnboarding(r.id)}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-brand-600 text-white text-xs font-semibold"
                          >
                            <UserCheck className="w-3.5 h-3.5" /> 确认入职建档
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mainTab === 'offboarding' && (
        <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                <tr>
                  <th className="px-5 py-3.5">单号 / 离职员工</th>
                  <th className="px-4 py-3.5">门店 / 部门 / 岗位</th>
                  <th className="px-4 py-3.5">离职原因与交接</th>
                  <th className="px-4 py-3.5">最后工作日</th>
                  <th className="px-4 py-3.5">流程状态</th>
                  <th className="px-5 py-3.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {offboardingList.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-stone-400">
                      暂无离职审批申请
                    </td>
                  </tr>
                ) : (
                  offboardingList.map((r) => (
                    <tr key={r.id} className="hover:bg-stone-50/70">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-stone-900">{r.employee_name}</div>
                        <div className="text-xs text-stone-400 font-mono">{r.request_no} · {r.emp_no}</div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div>{r.hotel_name}</div>
                        <div className="text-xs text-stone-500">{r.department_name} · {r.employee_position}</div>
                      </td>
                      <td className="px-4 py-3.5 text-xs">
                        <div className="font-medium text-stone-800">
                          {(dicts.RESIGN_REASON || []).find((d) => d.code === r.resign_reason_code)?.label || r.resign_reason_code}
                        </div>
                        <div className="text-stone-500 mt-0.5">{r.resign_reason_detail}</div>
                        {r.handover_to_name && (
                          <div className="text-stone-400 mt-0.5">工作交接人：{r.handover_to_name}</div>
                        )}
                        {r.unsettled_advances > 0 && (
                          <div className="text-rose-600 font-semibold mt-0.5">
                            注意：尚有 {r.unsettled_advances} 笔未冲销备用金
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3.5 text-xs tabular-nums">{r.last_working_date}</td>
                      <td className="px-4 py-3.5">
                        <StatusBadge status={r.status} />
                        {r.status_detail && <div className="text-[11px] text-stone-400 mt-0.5">{r.status_detail}</div>}
                      </td>
                      <td className="px-5 py-3.5 text-right space-x-2">
                        {r.canApprove && (
                          <>
                            <button
                              onClick={() => handleFlowAction('offboarding', r.id, 'APPROVE')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> 同意
                            </button>
                            <button
                              onClick={() => handleFlowAction('offboarding', r.id, 'REJECT')}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 text-xs font-medium"
                            >
                              <XCircle className="w-3.5 h-3.5" /> 驳回
                            </button>
                          </>
                        )}
                        {r.canComplete && (
                          <button
                            onClick={() => handleCompleteOffboarding(r.id)}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-rose-600 text-white text-xs font-semibold"
                          >
                            <Archive className="w-3.5 h-3.5" /> 确认离职并归档
                          </button>
                        )}
                        {r.status === 'COMPLETED' && (
                          <button
                            onClick={() => openArchiveDossier(r.employee_id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-stone-200 text-xs text-stone-700 hover:bg-stone-50"
                          >
                            <FileText className="w-3.5 h-3.5" /> 查看归档
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mainTab === 'archives' && (
        <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                <tr>
                  <th className="px-5 py-3.5">工号 / 姓名</th>
                  <th className="px-4 py-3.5">原所属门店 / 部门 / 岗位</th>
                  <th className="px-4 py-3.5">入职 / 离职日期</th>
                  <th className="px-4 py-3.5">归档业务记录摘要</th>
                  <th className="px-4 py-3.5">归档人</th>
                  <th className="px-5 py-3.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {archives.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-10 text-center text-sm text-stone-400">
                      暂无已离职员工归档档案
                    </td>
                  </tr>
                ) : (
                  archives.map((a) => (
                    <tr key={a.id} className="hover:bg-stone-50/70">
                      <td className="px-5 py-3.5">
                        <div className="font-semibold text-stone-900">{a.employee_name}</div>
                        <div className="text-xs text-stone-400 font-mono">{a.emp_no}</div>
                      </td>
                      <td className="px-4 py-3.5">
                        <div>{a.hotel_name}</div>
                        <div className="text-xs text-stone-500">{a.department_name} · {a.position}</div>
                      </td>
                      <td className="px-4 py-3.5 text-xs tabular-nums">
                        <div>入：{a.hire_date}</div>
                        <div className="text-rose-600">离：{a.resign_date}</div>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-stone-600">
                        异动 {a.summary?.eventCount || 0} · 报销 {a.summary?.reimbursementCount || 0} · 请假{' '}
                        {a.summary?.leaveCount || 0} · 薪资 {a.summary?.payrollCount || 0} · 排班{' '}
                        {a.summary?.shiftCount || 0}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-stone-500">
                        <div>{a.archived_by_name}</div>
                        <div className="text-[11px] text-stone-400">{a.archived_at}</div>
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          onClick={() => openArchiveDossier(a.employee_id)}
                          className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-stone-900 text-white text-xs font-medium"
                        >
                          <FileText className="w-3.5 h-3.5" /> 调阅完整归档
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Employee Detail Modal */}
      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.employee.name}（${selected.employee.emp_no}）` : ''}
        subtitle={
          selected
            ? `${selected.employee.hotel_name} · ${selected.employee.department_name} · ${selected.employee.position}`
            : ''
        }
      >
        {selected && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs bg-stone-50 p-4 rounded-xl border border-stone-200">
              <div>
                <span className="text-stone-400 block">手机号</span>
                <span className="font-medium">{selected.employee.phone}</span>
              </div>
              <div>
                <span className="text-stone-400 block">入职日期</span>
                <span className="font-medium">{selected.employee.hire_date}</span>
              </div>
              <div>
                <span className="text-stone-400 block">月基本底薪</span>
                <span className="font-semibold text-brand-700">{formatMoney(selected.employee.base_salary)}</span>
              </div>
              <div>
                <span className="text-stone-400 block">健康证到期日</span>
                <span className="font-medium">{selected.employee.health_cert_expiry || '未登记'}</span>
              </div>
              <div>
                <span className="text-stone-400 block">合同到期日</span>
                <span className="font-medium">{selected.employee.contract_end_date || '-'}</span>
              </div>
              <div>
                <span className="text-stone-400 block">学历类别</span>
                <span className="font-medium">
                  {(dicts.EDUCATION || []).find((d) => d.code === selected.employee.education)?.label ||
                    selected.employee.education ||
                    '-'}
                </span>
              </div>
              <div>
                <span className="text-stone-400 block">婚姻 / 政治面貌</span>
                <span className="font-medium">
                  {(dicts.MARITAL_STATUS || []).find((d) => d.code === selected.employee.marital_status)?.label || '-'} /{' '}
                  {(dicts.POLITICAL_STATUS || []).find((d) => d.code === selected.employee.political_status)?.label || '-'}
                </span>
              </div>
              <div>
                <span className="text-stone-400 block">当前状态</span>
                <StatusBadge status={selected.employee.status} />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold uppercase text-stone-500">入转调离生命周期记录</h4>
                <div className="flex items-center gap-2">
                  {selected.employee.status === 'RESIGNED' && (
                    <button
                      onClick={() => openArchiveDossier(selected.employee.id)}
                      className="px-3 py-1.5 rounded-lg bg-stone-900 text-white text-xs font-semibold flex items-center gap-1"
                    >
                      <Archive className="w-3.5 h-3.5" /> 查看离职归档档案
                    </button>
                  )}
                  {canManage && selected.employee.status !== 'RESIGNED' && (
                    <button
                      onClick={() => setLifecycleOpen(true)}
                      className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold flex items-center gap-1"
                    >
                      <UserCog className="w-3.5 h-3.5" /> 办理人事变动
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2.5 border-l-2 border-stone-200 pl-4 ml-1">
                {selected.events.length === 0 ? (
                  <div className="text-xs text-stone-400">暂无变动记录</div>
                ) : (
                  selected.events.map((ev) => (
                    <div key={ev.id} className="text-xs">
                      <div className="font-semibold text-stone-800">
                        {EVENT_LABELS[ev.event_type] || ev.event_type} · {ev.effective_date}
                      </div>
                      <div className="text-stone-600 mt-0.5">{ev.reason}</div>
                      {(ev.from_hotel_name || ev.to_hotel_name) && (
                        <div className="text-stone-400 mt-0.5">
                          {ev.from_hotel_name || '-'} ({ev.from_position || '-'}) → {ev.to_hotel_name || '-'} (
                          {ev.to_position || '-'})
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Lifecycle Action Modal */}
      <Modal open={lifecycleOpen} onClose={() => setLifecycleOpen(false)} title="办理人事变动（入转调离）">
        <form onSubmit={handleLifecycle} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">变动类型</label>
            <select
              value={lcType}
              onChange={(e) => setLcType(e.target.value as typeof lcType)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
            >
              <option value="CONFIRM">试用期转正</option>
              <option value="TRANSFER">跨店/跨部门调动</option>
              <option value="PROMOTE">晋升调岗</option>
              <option value="RESIGN">办理离职</option>
            </select>
          </div>
          {lcType === 'TRANSFER' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">调入门店</label>
                <select
                  value={lcHotelId}
                  onChange={(e) => {
                    const hid = Number(e.target.value);
                    setLcHotelId(hid);
                    const d = departments.find((x) => x.hotel_id === hid);
                    if (d) setLcDeptId(d.id);
                  }}
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
                <label className="block text-xs font-medium text-stone-700 mb-1">调入部门</label>
                <select
                  value={lcDeptId}
                  onChange={(e) => setLcDeptId(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                >
                  {departments
                    .filter((d) => d.hotel_id === lcHotelId)
                    .map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}
          {(lcType === 'TRANSFER' || lcType === 'PROMOTE') && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">新岗位名称</label>
              <input
                type="text"
                value={lcPos}
                onChange={(e) => setLcPos(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">变动原因</label>
            <textarea
              rows={2}
              value={lcReason}
              onChange={(e) => setLcReason(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setLifecycleOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认生效
            </button>
          </div>
        </form>
      </Modal>

      {/* Onboard Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={cMode === 'workflow' ? '发起新员工入职审批申请' : '直接办理新员工入职建档'}
      >
        <form onSubmit={handleOnboard} className="space-y-4">
          <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl w-fit">
            <button
              type="button"
              onClick={() => setCMode('workflow')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                cMode === 'workflow' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
              }`}
            >
              走入职审批流程
            </button>
            <button
              type="button"
              onClick={() => setCMode('direct')}
              className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                cMode === 'direct' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'
              }`}
            >
              直接入职建档
            </button>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">姓名 *</label>
              <input
                type="text"
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">性别 *</label>
              <select
                value={cGender}
                onChange={(e) => setCGender(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.GENDER || [
                  { code: 'M', label: '男' },
                  { code: 'F', label: '女' },
                ]).map((g) => (
                  <option key={g.code} value={g.code}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">手机号 *</label>
              <input
                type="text"
                value={cPhone}
                onChange={(e) => setCPhone(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属机构/门店</label>
              <select
                value={cHotelId}
                onChange={(e) => {
                  const hid = Number(e.target.value);
                  setCHotelId(hid);
                  const d = departments.find((x) => x.hotel_id === hid);
                  if (d) setCDeptId(d.id);
                  setCPositionId(0);
                }}
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
              <label className="block text-xs font-medium text-stone-700 mb-1">所属部门</label>
              <select
                value={cDeptId}
                onChange={(e) => {
                  setCDeptId(Number(e.target.value));
                  setCPositionId(0);
                }}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {departments
                  .filter((d) => d.hotel_id === cHotelId)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">部门职位 *</label>
              {(() => {
                const selectedHotel = hotels.find((h) => h.id === cHotelId);
                const selectedDept = departments.find((d) => d.id === cDeptId);
                const orgLevel = selectedHotel?.is_hq ? 'HQ' : 'STORE';
                const tpl = selectedDept
                  ? deptTemplates.find((dt) => dt.org_level === orgLevel && dt.code === selectedDept.code)
                  : undefined;
                const posOpts = tpl
                  ? jobPositions.filter((p) => p.org_level === orgLevel && p.dept_template_id === tpl.id)
                  : [];
                return posOpts.length > 0 ? (
                  <select
                    value={cPositionId || ''}
                    onChange={(e) => {
                      const pid = Number(e.target.value);
                      setCPositionId(pid);
                      const picked = posOpts.find((p) => p.id === pid);
                      if (picked) setCPos(picked.name);
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                    required
                  >
                    <option value="">请选择职位</option>
                    {posOpts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={cPos}
                    onChange={(e) => setCPos(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                    required
                  />
                );
              })()}
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">学历类别</label>
              <select
                value={cEducation}
                onChange={(e) => setCEducation(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.EDUCATION || [{ code: 'BACHELOR', label: '本科' }]).map((ed) => (
                  <option key={ed.code} value={ed.code}>
                    {ed.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">用工性质</label>
              <select
                value={cEmploymentType}
                onChange={(e) => setCEmploymentType(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.EMPLOYMENT_TYPE || [{ code: 'FULL_TIME', label: '全职' }]).map((et) => (
                  <option key={et.code} value={et.code}>
                    {et.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">婚姻状况</label>
              <select
                value={cMaritalStatus}
                onChange={(e) => setCMaritalStatus(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.MARITAL_STATUS || [{ code: 'SINGLE', label: '未婚' }]).map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">政治面貌</label>
              <select
                value={cPoliticalStatus}
                onChange={(e) => setCPoliticalStatus(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.POLITICAL_STATUS || [{ code: 'MASSES', label: '群众' }]).map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">月基本底薪 *</label>
              <input
                type="number"
                value={cSalary}
                onChange={(e) => setCSalary(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">
                {cMode === 'workflow' ? '拟入职日期' : '入职日期'}
              </label>
              <input
                type="date"
                value={cPlannedDate}
                onChange={(e) => setCPlannedDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">健康证到期日</label>
              <input
                type="date"
                value={cHealthExpiry}
                onChange={(e) => setCHealthExpiry(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          </div>
          {cMode === 'workflow' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">入职说明</label>
              <textarea
                rows={2}
                value={cRemarks}
                onChange={(e) => setCRemarks(e.target.value)}
                placeholder="选填：招聘来源、试用期安排等"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              {cMode === 'workflow' ? '提交入职审批' : '确认入职'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Offboarding Request Modal */}
      <Modal open={offOpen} onClose={() => setOffOpen(false)} title="发起员工离职审批申请">
        <form onSubmit={handleSubmitOffboarding} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">离职员工 *</label>
              <select
                value={offEmpId}
                onChange={(e) => setOffEmpId(Number(e.target.value))}
                disabled={!canManage}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white disabled:bg-stone-50"
                required
              >
                {employees
                  .filter((e) => e.status !== 'RESIGNED')
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}（{e.emp_no} · {e.hotel_name}）
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">最后工作日 *</label>
              <input
                type="date"
                value={offLastDate}
                onChange={(e) => setOffLastDate(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">离职原因分类 *</label>
              <select
                value={offReasonCode}
                onChange={(e) => setOffReasonCode(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {(dicts.RESIGN_REASON || [{ code: 'PERSONAL_DEV', label: '个人职业发展' }]).map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">工作交接人</label>
              <select
                value={offHandoverEmpId}
                onChange={(e) => setOffHandoverEmpId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value={0}>暂不指定</option>
                {employees
                  .filter((e) => e.status !== 'RESIGNED' && e.id !== offEmpId)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}（{e.position}）
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">离职详细说明 *</label>
            <textarea
              rows={2}
              value={offReasonDetail}
              onChange={(e) => setOffReasonDetail(e.target.value)}
              placeholder="请填写离职具体说明"
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">工作交接事项</label>
            <textarea
              rows={2}
              value={offHandoverNotes}
              onChange={(e) => setOffHandoverNotes(e.target.value)}
              placeholder="选填：客户资料、钥匙工牌、设备台账等交接清单"
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOffOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-rose-600 text-white text-sm font-semibold">
              提交离职审批
            </button>
          </div>
        </form>
      </Modal>

      {/* Archive Dossier Modal */}
      <Modal
        open={Boolean(archiveDetail)}
        onClose={() => setArchiveDetail(null)}
        title={archiveDetail ? `离职归档档案 · ${archiveDetail.employee_name}（${archiveDetail.emp_no}）` : ''}
        subtitle={
          archiveDetail
            ? `${archiveDetail.hotel_name} · ${archiveDetail.department_name} · ${archiveDetail.position}`
            : ''
        }
      >
        {archiveDetail && (
          <div className="space-y-4 text-xs max-h-[70vh] overflow-y-auto pr-1">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-stone-50 p-3.5 rounded-xl border border-stone-200">
              <div>
                <span className="text-stone-400 block">入职日期</span>
                <span className="font-semibold">{archiveDetail.hire_date}</span>
              </div>
              <div>
                <span className="text-stone-400 block">离职日期</span>
                <span className="font-semibold text-rose-600">{archiveDetail.resign_date}</span>
              </div>
              <div>
                <span className="text-stone-400 block">归档操作人</span>
                <span className="font-medium">{archiveDetail.archived_by_name}</span>
              </div>
              <div>
                <span className="text-stone-400 block">归档时间</span>
                <span className="font-medium">{archiveDetail.archived_at}</span>
              </div>
              <div className="col-span-2 sm:col-span-4">
                <span className="text-stone-400 block">离职原因</span>
                <span className="text-stone-800">{archiveDetail.resign_reason}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
              {[
                { label: '异动记录', val: archiveDetail.summary.eventCount || 0 },
                { label: '报销单', val: archiveDetail.summary.reimbursementCount || 0 },
                { label: '备用金', val: archiveDetail.summary.advanceCount || 0 },
                { label: '请假加班', val: archiveDetail.summary.leaveCount || 0 },
                { label: '薪资记录', val: archiveDetail.summary.payrollCount || 0 },
                { label: '排班记录', val: archiveDetail.summary.shiftCount || 0 },
              ].map((s) => (
                <div key={s.label} className="p-2.5 rounded-xl bg-stone-50 border border-stone-200">
                  <div className="text-base font-bold text-stone-900">{s.val}</div>
                  <div className="text-[11px] text-stone-500">{s.label}</div>
                </div>
              ))}
            </div>

            {archiveDetail.records.lifecycleEvents && archiveDetail.records.lifecycleEvents.length > 0 && (
              <div>
                <h4 className="font-semibold text-stone-700 mb-1.5">人事异动归档</h4>
                <div className="space-y-1 border border-stone-200 rounded-xl p-2.5 bg-white">
                  {archiveDetail.records.lifecycleEvents.map((ev: any) => (
                    <div key={ev.id} className="flex justify-between gap-2 py-1 border-b border-stone-100 last:border-0">
                      <span>
                        <span className="font-semibold">{EVENT_LABELS[ev.event_type] || ev.event_type}</span> · {ev.reason}
                      </span>
                      <span className="text-stone-400 shrink-0">{ev.effective_date}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {archiveDetail.records.reimbursements && archiveDetail.records.reimbursements.length > 0 && (
              <div>
                <h4 className="font-semibold text-stone-700 mb-1.5">历史报销单归档</h4>
                <div className="space-y-1 border border-stone-200 rounded-xl p-2.5 bg-white">
                  {archiveDetail.records.reimbursements.map((r: any) => (
                    <div key={r.id} className="flex justify-between gap-2 py-1 border-b border-stone-100 last:border-0">
                      <span>
                        <span className="font-mono text-stone-500 mr-1.5">{r.claim_no}</span>
                        {r.title}
                      </span>
                      <span className="font-semibold shrink-0">{formatMoney(r.total_amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {archiveDetail.records.leaveRequests && archiveDetail.records.leaveRequests.length > 0 && (
              <div>
                <h4 className="font-semibold text-stone-700 mb-1.5">历史请假/加班归档</h4>
                <div className="space-y-1 border border-stone-200 rounded-xl p-2.5 bg-white">
                  {archiveDetail.records.leaveRequests.map((l: any) => (
                    <div key={l.id} className="flex justify-between gap-2 py-1 border-b border-stone-100 last:border-0">
                      <span>
                        <span className="font-mono text-stone-500 mr-1.5">{l.request_no}</span>
                        {l.leave_type} · {l.start_date} ~ {l.end_date}（{l.days}天）
                      </span>
                      <StatusBadge status={l.status} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {archiveDetail.records.payrollRecords && archiveDetail.records.payrollRecords.length > 0 && (
              <div>
                <h4 className="font-semibold text-stone-700 mb-1.5">历史薪资台账归档</h4>
                <div className="space-y-1 border border-stone-200 rounded-xl p-2.5 bg-white">
                  {archiveDetail.records.payrollRecords.map((p: any) => (
                    <div key={p.id} className="flex justify-between gap-2 py-1 border-b border-stone-100 last:border-0">
                      <span>{p.year_month} 实发薪资</span>
                      <span className="font-semibold">{formatMoney(p.net_pay)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
