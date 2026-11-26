import React, { useCallback, useEffect, useState } from 'react';
import { Check, Plus, UserCheck, XCircle } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/format';

interface HeadcountRow {
  id: number;
  request_no: string;
  hotel_name: string;
  department_name: string;
  position: string;
  headcount: number;
  urgency: string;
  salary_range: string;
  reason: string;
  applicant_name: string;
  status: string;
  current_step_name: string | null;
  canApprove: boolean;
}

interface CandidateRow {
  id: number;
  hotel_id: number;
  hotel_name: string;
  department_name: string;
  name: string;
  phone: string;
  position: string;
  expected_salary: number;
  stage: string;
  interview_notes: string | null;
  headcount_request_no: string | null;
}

export function RecruitmentPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [tab, setTab] = useState<'headcounts' | 'candidates'>('headcounts');
  const [headcounts, setHeadcounts] = useState<HeadcountRow[]>([]);
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [hotels, setHotels] = useState<Array<{ id: number; name: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; hotel_id: number; name: string }>>([]);

  // Create headcount
  const [hcOpen, setHcOpen] = useState(false);
  const [hcHotelId, setHcHotelId] = useState<number>(user?.hotel_id || 2);
  const [hcDeptId, setHcDeptId] = useState<number>(1);
  const [hcPos, setHcPos] = useState('');
  const [hcCount, setHcCount] = useState(1);
  const [hcUrgency, setHcUrgency] = useState<'NORMAL' | 'URGENT'>('NORMAL');
  const [hcSalary, setHcSalary] = useState('6000-7500元/月');
  const [hcReason, setHcReason] = useState('');

  // Create candidate
  const [candOpen, setCandOpen] = useState(false);
  const [cHotelId, setCHotelId] = useState<number>(user?.hotel_id || 2);
  const [cDeptId, setCDeptId] = useState<number>(1);
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cPos, setCPos] = useState('');
  const [cSalary, setCSalary] = useState(6500);
  const [cNotes, setCNotes] = useState('');

  const load = useCallback(async () => {
    const [hcRes, candRes] = await Promise.all([
      apiFetch<{ headcounts: HeadcountRow[] }>('/api/recruitment/headcounts'),
      apiFetch<{ candidates: CandidateRow[] }>('/api/recruitment/candidates'),
    ]);
    setHeadcounts(hcRes.headcounts);
    setCandidates(candRes.candidates);
  }, []);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  useEffect(() => {
    apiFetch<{
      hotels: Array<{ id: number; name: string }>;
      departments: Array<{ id: number; hotel_id: number; name: string }>;
    }>('/api/organization/hotels?all=true').then((d) => {
      setHotels(d.hotels);
      setDepartments(d.departments);
      const hid = user?.hotel_id || d.hotels[0]?.id || 2;
      setHcHotelId(hid);
      setCHotelId(hid);
      const dept = d.departments.find((x) => x.hotel_id === hid);
      if (dept) {
        setHcDeptId(dept.id);
        setCDeptId(dept.id);
      }
    });
  }, [user?.hotel_id]);

  const handleCreateHc = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/recruitment/headcounts', {
        method: 'POST',
        body: JSON.stringify({
          hotel_id: hcHotelId,
          department_id: hcDeptId,
          position: hcPos,
          headcount: Number(hcCount),
          urgency: hcUrgency,
          salary_range: hcSalary,
          reason: hcReason,
        }),
      });
      showToast('门店补编申请已提交审批');
      setHcOpen(false);
      setHcPos('');
      setHcReason('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交失败', 'error');
    }
  };

  const handleHcAction = async (id: number, action: 'APPROVE' | 'REJECT') => {
    try {
      await apiFetch(`/api/recruitment/headcounts/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, comment: action === 'APPROVE' ? '同意补编' : '暂缓' }),
      });
      showToast(action === 'APPROVE' ? '已批准补编' : '已驳回');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const handleCreateCandidate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/recruitment/candidates', {
        method: 'POST',
        body: JSON.stringify({
          hotel_id: cHotelId,
          department_id: cDeptId,
          name: cName,
          phone: cPhone,
          position: cPos,
          expected_salary: Number(cSalary),
          interview_notes: cNotes || null,
        }),
      });
      showToast('候选人已录入');
      setCandOpen(false);
      setCName('');
      setCPhone('');
      setCPos('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '录入失败', 'error');
    }
  };

  const handleStageChange = async (id: number, stage: string) => {
    try {
      await apiFetch(`/api/recruitment/candidates/${id}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
      });
      showToast('候选人阶段已更新');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失败', 'error');
    }
  };

  const handleHire = async (c: CandidateRow) => {
    try {
      const res = await apiFetch<{ empNo: string; username: string }>(
        `/api/recruitment/candidates/${c.id}/hire`,
        {
          method: 'POST',
          body: JSON.stringify({}),
        }
      );
      showToast(`已一键办理入职！工号 ${res.empNo}，登录账号 ${res.username}（默认密码 Hotel@2026）`);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '入职失败', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">用工补编与招聘入职</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            门店补编审批、候选人面试跟进，以及 Offer 候选人一键办理入职建档与账号开通
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setHcOpen(true)}
            className="px-3.5 py-2 rounded-xl bg-white border border-stone-200 text-stone-800 text-sm font-medium flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 申请门店补编
          </button>
          <button
            onClick={() => setCandOpen(true)}
            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 录入候选人
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit">
        <button
          onClick={() => setTab('headcounts')}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
            tab === 'headcounts' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
          }`}
        >
          门店补编申请 ({headcounts.length})
        </button>
        <button
          onClick={() => setTab('candidates')}
          className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold ${
            tab === 'candidates' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
          }`}
        >
          候选人跟进 ({candidates.length})
        </button>
      </div>

      {tab === 'headcounts' && (
        <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
              <tr>
                <th className="px-5 py-3.5">单号 / 门店部门</th>
                <th className="px-4 py-3.5">需求岗位 / 人数</th>
                <th className="px-4 py-3.5">薪资预算</th>
                <th className="px-4 py-3.5">补编原因</th>
                <th className="px-4 py-3.5">状态</th>
                <th className="px-5 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {headcounts.map((hc) => (
                <tr key={hc.id} className="hover:bg-stone-50/70">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-stone-900">
                      {hc.hotel_name} · {hc.department_name}
                    </div>
                    <div className="text-xs text-stone-400 font-mono">
                      {hc.request_no} · 申请人：{hc.applicant_name}
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="font-medium text-stone-900">{hc.position}</span> × {hc.headcount} 人
                    {hc.urgency === 'URGENT' && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 text-[11px] font-medium">
                        加急
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-xs text-stone-600">{hc.salary_range}</td>
                  <td className="px-4 py-3.5 text-xs text-stone-600 max-w-xs truncate">{hc.reason}</td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={hc.status} />
                    {hc.current_step_name && (
                      <div className="text-[11px] text-stone-500 mt-1">{hc.current_step_name}</div>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right space-x-2">
                    {hc.canApprove && (
                      <>
                        <button
                          onClick={() => handleHcAction(hc.id, 'APPROVE')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-xs font-medium"
                        >
                          <Check className="w-3.5 h-3.5" /> 批准
                        </button>
                        <button
                          onClick={() => handleHcAction(hc.id, 'REJECT')}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 text-rose-700 text-xs font-medium"
                        >
                          <XCircle className="w-3.5 h-3.5" /> 驳回
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'candidates' && (
        <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
              <tr>
                <th className="px-5 py-3.5">候选人</th>
                <th className="px-4 py-3.5">应聘门店 / 岗位</th>
                <th className="px-4 py-3.5 text-right">期望月薪</th>
                <th className="px-4 py-3.5">面试评价</th>
                <th className="px-4 py-3.5">当前阶段</th>
                <th className="px-5 py-3.5 text-right">流转与入职</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {candidates.map((c) => (
                <tr key={c.id} className="hover:bg-stone-50/70">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-stone-900">{c.name}</div>
                    <div className="text-xs text-stone-400">{c.phone}</div>
                  </td>
                  <td className="px-4 py-3.5">
                    <div>
                      {c.hotel_name} · {c.department_name}
                    </div>
                    <div className="text-xs text-stone-500">{c.position}</div>
                  </td>
                  <td className="px-4 py-3.5 text-right tabular-nums font-medium">
                    {formatMoney(c.expected_salary)}
                  </td>
                  <td className="px-4 py-3.5 text-xs text-stone-600 max-w-xs truncate">
                    {c.interview_notes || '-'}
                  </td>
                  <td className="px-4 py-3.5">
                    <StatusBadge status={c.stage} />
                  </td>
                  <td className="px-5 py-3.5 text-right space-x-2">
                    {c.stage === 'SCREENING' && (
                      <button
                        onClick={() => handleStageChange(c.id, 'INTERVIEW')}
                        className="px-2.5 py-1 rounded-lg border border-stone-200 text-xs font-medium hover:bg-stone-50"
                      >
                        推进面试
                      </button>
                    )}
                    {c.stage === 'INTERVIEW' && (
                      <button
                        onClick={() => handleStageChange(c.id, 'OFFERED')}
                        className="px-2.5 py-1 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-xs font-medium"
                      >
                        发放 Offer
                      </button>
                    )}
                    {c.stage === 'OFFERED' && (
                      <button
                        onClick={() => handleHire(c)}
                        className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold"
                      >
                        <UserCheck className="w-3.5 h-3.5" /> 一键办理入职
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={hcOpen} onClose={() => setHcOpen(false)} title="发起门店补编申请">
        <form onSubmit={handleCreateHc} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">门店</label>
              <select
                value={hcHotelId}
                onChange={(e) => {
                  const hid = Number(e.target.value);
                  setHcHotelId(hid);
                  const d = departments.find((x) => x.hotel_id === hid);
                  if (d) setHcDeptId(d.id);
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
              <label className="block text-xs font-medium text-stone-700 mb-1">部门</label>
              <select
                value={hcDeptId}
                onChange={(e) => setHcDeptId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {departments
                  .filter((d) => d.hotel_id === hcHotelId)
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
              <label className="block text-xs font-medium text-stone-700 mb-1">岗位名称</label>
              <input
                type="text"
                value={hcPos}
                onChange={(e) => setHcPos(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">补编人数</label>
              <input
                type="number"
                min="1"
                value={hcCount}
                onChange={(e) => setHcCount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">紧急程度</label>
              <select
                value={hcUrgency}
                onChange={(e) => setHcUrgency(e.target.value as 'NORMAL' | 'URGENT')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="NORMAL">常规</option>
                <option value="URGENT">加急（直呈总经理）</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">薪资范围</label>
            <input
              type="text"
              value={hcSalary}
              onChange={(e) => setHcSalary(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">补编原因</label>
            <textarea
              rows={2}
              value={hcReason}
              onChange={(e) => setHcReason(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setHcOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              提交申请
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={candOpen} onClose={() => setCandOpen(false)} title="录入招聘候选人">
        <form onSubmit={handleCreateCandidate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">姓名</label>
              <input
                type="text"
                value={cName}
                onChange={(e) => setCName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">联系电话</label>
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
              <label className="block text-xs font-medium text-stone-700 mb-1">应聘门店</label>
              <select
                value={cHotelId}
                onChange={(e) => {
                  const hid = Number(e.target.value);
                  setCHotelId(hid);
                  const d = departments.find((x) => x.hotel_id === hid);
                  if (d) setCDeptId(d.id);
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
              <label className="block text-xs font-medium text-stone-700 mb-1">应聘部门</label>
              <select
                value={cDeptId}
                onChange={(e) => setCDeptId(Number(e.target.value))}
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
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">应聘岗位</label>
              <input
                type="text"
                value={cPos}
                onChange={(e) => setCPos(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">期望月薪（元）</label>
              <input
                type="number"
                value={cSalary}
                onChange={(e) => setCSalary(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">初筛/面试备注</label>
            <textarea
              rows={2}
              value={cNotes}
              onChange={(e) => setCNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCandOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存候选人
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
