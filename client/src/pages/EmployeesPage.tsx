import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Plus, Search, UserCog } from 'lucide-react';
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

  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [hotels, setHotels] = useState<Array<{ id: number; name: string }>>([]);
  const [departments, setDepartments] = useState<Array<{ id: number; hotel_id: number; name: string }>>([]);

  const [keyword, setKeyword] = useState('');
  const [alertType, setAlertType] = useState('');

  // Detail & lifecycle
  const [selected, setSelected] = useState<{ employee: EmployeeRow; events: LifecycleEvent[] } | null>(null);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lcType, setLcType] = useState<'CONFIRM' | 'TRANSFER' | 'PROMOTE' | 'RESIGN'>('TRANSFER');
  const [lcHotelId, setLcHotelId] = useState<number>(0);
  const [lcDeptId, setLcDeptId] = useState<number>(1);
  const [lcPos, setLcPos] = useState('');
  const [lcReason, setLcReason] = useState('');

  // Onboard modal
  const [createOpen, setCreateOpen] = useState(false);
  const [cName, setCName] = useState('');
  const [cPhone, setCPhone] = useState('');
  const [cHotelId, setCHotelId] = useState<number>(user?.hotel_id || 0);
  const [cDeptId, setCDeptId] = useState<number>(1);
  const [cPos, setCPos] = useState('前台接待员');
  const [cSalary, setCSalary] = useState(6500);
  const [cHealthExpiry, setCHealthExpiry] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (keyword.trim()) params.set('keyword', keyword.trim());
    if (alertType) params.set('alertType', alertType);
    const data = await apiFetch<{ employees: EmployeeRow[] }>(`/api/employees?${params.toString()}`);
    setEmployees(data.employees);
  }, [keyword, alertType]);

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
      setCHotelId(hid);
      const firstDept = d.departments.find((x) => x.hotel_id === hid);
      if (firstDept) setCDeptId(firstDept.id);
    });
  }, [user?.hotel_id]);

  const openDetail = async (id: number) => {
    const d = await apiFetch<{ employee: EmployeeRow; events: LifecycleEvent[] }>(`/api/employees/${id}`);
    setSelected(d);
    setLcHotelId(d.employee.hotel_id);
    setLcDeptId(d.employee.department_id);
    setLcPos(d.employee.position);
  };

  const handleOnboard = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          name: cName,
          phone: cPhone,
          hotel_id: cHotelId,
          department_id: cDeptId,
          position: cPos,
          base_salary: Number(cSalary),
          health_cert_expiry: cHealthExpiry || null,
          hire_date: todayStr(),
        }),
      });
      showToast('员工入职建档成功');
      setCreateOpen(false);
      setCName('');
      setCPhone('');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '建档失败', 'error');
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
          <h1 className="text-2xl font-bold text-stone-900">员工档案与合规预警</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            覆盖入转调离全生命周期、劳动合同与酒店健康证到期自动预警
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setCreateOpen(true)}
            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 办理员工入职
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-stone-200/90 p-4 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl">
          {[
            { key: '', label: '全部员工' },
            { key: 'health_cert', label: '健康证到期/过期预警' },
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
                <span className="text-stone-400 block">当前状态</span>
                <StatusBadge status={selected.employee.status} />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-semibold uppercase text-stone-500">入转调离生命周期记录</h4>
                {canManage && selected.employee.status !== 'RESIGNED' && (
                  <button
                    onClick={() => setLifecycleOpen(true)}
                    className="px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold flex items-center gap-1"
                  >
                    <UserCog className="w-3.5 h-3.5" /> 办理人事变动
                  </button>
                )}
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
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="办理新员工入职建档">
        <form onSubmit={handleOnboard} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
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
              <label className="block text-xs font-medium text-stone-700 mb-1">所属门店</label>
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
              <label className="block text-xs font-medium text-stone-700 mb-1">所属部门</label>
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
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">岗位名称 *</label>
              <input
                type="text"
                value={cPos}
                onChange={(e) => setCPos(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
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
              <label className="block text-xs font-medium text-stone-700 mb-1">健康证到期日</label>
              <input
                type="date"
                value={cHealthExpiry}
                onChange={(e) => setCHealthExpiry(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateOpen(false)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              确认入职
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
