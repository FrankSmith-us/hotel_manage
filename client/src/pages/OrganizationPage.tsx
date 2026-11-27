import React, { useEffect, useState } from 'react';
import { Building2, MapPin, Phone, Plus, UserCog, Users } from 'lucide-react';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';

interface RegionNode {
  id: number;
  code: string;
  name: string;
  manager_user_id: number | null;
  manager_name: string | null;
  manager_role: string | null;
  is_manager_same_as_gm: boolean;
  hotels: Array<{
    id: number;
    code: string;
    name: string;
    city: string;
    district?: string | null;
    address: string;
    phone: string;
    room_count: number;
    is_hq: number;
    status: string;
    manager_name: string | null;
    employee_count: number;
    departments: Array<{ id: number; name: string; employee_count: number }>;
  }>;
}

interface ManagerCandidate {
  id: number;
  username: string;
  display_name: string;
  role: string;
}

interface RegionOption {
  id: number;
  code: string;
  name: string;
}

interface ClosureRequest {
  id: number;
  request_no: string;
  hotel_id: number;
  hotel_name: string;
  hotel_code: string;
  region_name: string;
  reason: string;
  applicant_id: number;
  applicant_name: string;
  status: string;
  status_detail: string;
  non_resigned_employee_count: number;
  can_approve: boolean;
  closed_at: string | null;
  created_at: string;
  steps: Array<{
    step_order: number;
    step_name: string;
    approver_role: string;
    approver_name: string | null;
    status: string;
    acted_by_name: string | null;
    acted_at: string | null;
    comment: string | null;
  }>;
}

export function OrganizationPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canManageRegion = ['HQ_ADMIN', 'GENERAL_MANAGER'].includes(user?.role || '');
  const [regions, setRegions] = useState<RegionNode[]>([]);
  const [regionOptions, setRegionOptions] = useState<RegionOption[]>([]);
  const [cities, setCities] = useState<Array<{ id: number; region_id: number; name: string }>>([]);
  const [districts, setDistricts] = useState<Array<{ id: number; city_id: number; name: string }>>([]);
  const [hotelStatuses, setHotelStatuses] = useState<Array<{ code: string; label: string }>>([]);
  const [candidates, setCandidates] = useState<ManagerCandidate[]>([]);
  const [closureRequests, setClosureRequests] = useState<ClosureRequest[]>([]);
  const [closingHotel, setClosingHotel] = useState<RegionNode['hotels'][number] | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const [open, setOpen] = useState(false);

  const [editingRegion, setEditingRegion] = useState<RegionNode | null>(null);
  const [selectedManagerId, setSelectedManagerId] = useState<string>('');

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState(0);
  const [cityId, setCityId] = useState<number>(0);
  const [districtId, setDistrictId] = useState<number>(0);
  const [hotelStatus, setHotelStatus] = useState('OPEN');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [roomCount, setRoomCount] = useState(120);
  const [budgetTemplateHotelId, setBudgetTemplateHotelId] = useState<number>(0);

  const load = () => {
    Promise.all([
      apiFetch<{ regions: RegionNode[]; regionOptions?: RegionOption[]; managerCandidates: ManagerCandidate[] }>(
        '/api/organization/tree'
      ),
      apiFetch<{
        regions: RegionOption[];
        cities: Array<{ id: number; region_id: number; name: string }>;
        districts: Array<{ id: number; city_id: number; name: string }>;
        dicts: Record<string, Array<{ code: string; label: string }>>;
      }>('/api/master-data/options'),
      apiFetch<{ requests: ClosureRequest[] }>('/api/organization/closure-requests'),
    ]).then(([d, md, cr]) => {
      setRegions(d.regions);
      setClosureRequests(cr.requests || []);
      const opts =
        md.regions.length > 0
          ? md.regions
          : d.regionOptions && d.regionOptions.length > 0
            ? d.regionOptions
            : d.regions.filter((r) => r.code !== 'HQ').map((r) => ({ id: r.id, code: r.code, name: r.name }));
      setRegionOptions(opts);
      setCities(md.cities || []);
      setDistricts(md.districts || []);
      const statuses = md.dicts?.HOTEL_STATUS || [];
      setHotelStatuses(statuses);
      const nextRegId = opts.some((o) => o.id === regionId) ? regionId : opts[0]?.id || 0;
      setRegionId(nextRegId);
      const firstCity = (md.cities || []).find((c) => c.region_id === nextRegId);
      setCityId(firstCity?.id || 0);
      const firstDist = firstCity ? (md.districts || []).find((dt) => dt.city_id === firstCity.id) : undefined;
      setDistrictId(firstDist?.id || 0);
      if (statuses.length > 0 && !statuses.some((s) => s.code === hotelStatus)) {
        setHotelStatus(statuses.find((s) => s.code === 'OPEN')?.code || statuses[0].code);
      }
      setCandidates(d.managerCandidates || []);
    });
  };

  useEffect(() => {
    load();
  }, [user?.id]);

  const handleSaveRegionManager = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRegion) return;
    try {
      await apiFetch(`/api/organization/regions/${editingRegion.id}/manager`, {
        method: 'PUT',
        body: JSON.stringify({
          manager_user_id: selectedManagerId ? Number(selectedManagerId) : null,
        }),
      });
      showToast('区域负责人已更新，后续审批将自动按新规则路由');
      setEditingRegion(null);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失败', 'error');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/organization/hotels', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          region_id: Number(regionId),
          city_id: cityId || null,
          district_id: districtId || null,
          status: hotelStatus,
          address,
          phone,
          room_count: Number(roomCount),
          budget_template_hotel_id: budgetTemplateHotelId || null,
        }),
      });
      showToast('新门店已创建并自动初始化部门架构');
      setOpen(false);
      setCode('');
      setName('');
      setAddress('');
      setPhone('');
      setBudgetTemplateHotelId(0);
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败', 'error');
    }
  };

  const handleStatusChange = async (hid: number, nextStatus: string) => {
    try {
      await apiFetch(`/api/organization/hotels/${hid}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      showToast('门店状态已更新');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '状态更新失败', 'error');
    }
  };

  const handleRequestClosure = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closingHotel) return;
    try {
      await apiFetch(`/api/organization/hotels/${closingHotel.id}/closure-requests`, {
        method: 'POST',
        body: JSON.stringify({ reason: closeReason }),
      });
      showToast('关店申请已提交，等待区域总及集团总经理审批');
      setClosingHotel(null);
      setCloseReason('');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '提交关店申请失败', 'error');
    }
  };

  const handleClosureAction = async (id: number, action: 'APPROVE' | 'REJECT') => {
    const comment = action === 'REJECT' ? window.prompt('请输入驳回原因（可选）：') || '' : '';
    try {
      const res = await apiFetch<{ request: { status: string } }>(`/api/organization/closure-requests/${id}/action`, {
        method: 'POST',
        body: JSON.stringify({ action, comment }),
      });
      showToast(
        res.request.status === 'APPROVED'
          ? '已终审批准，门店状态已更新为关闭'
          : action === 'APPROVE'
            ? '审批通过，已流转至下一节点'
            : '已驳回关店申请'
      );
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '审批操作失败', 'error');
    }
  };

  const handleCancelClosure = async (id: number) => {
    try {
      await apiFetch(`/api/organization/closure-requests/${id}/cancel`, { method: 'POST' });
      showToast('已撤销关店申请');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '撤销失败', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">连锁门店与组织架构</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            集团总部 — 区域 — 门店三级管理架构与各部门在编人数
          </p>
        </div>
        {['HQ_ADMIN', 'HR_MANAGER'].includes(user?.role || '') && (
          <button
            onClick={() => setOpen(true)}
            className="px-4 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> 新增门店
          </button>
        )}
      </div>

      {regions.map((reg) => (
        <div key={reg.id} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm font-bold text-stone-700">
              <Building2 className="w-4 h-4 text-brand-600" />
              <span>{reg.name}</span>
              <span className="text-xs font-normal text-stone-400">({reg.hotels.length} 家机构)</span>
              {reg.manager_name && (
                <span className="text-xs font-medium text-stone-600 px-2.5 py-0.5 rounded-full bg-white border border-stone-200">
                  区域负责人：{reg.manager_name}
                </span>
              )}
              {reg.is_manager_same_as_gm && (
                <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                  总经理兼任 · 审批自动跳过区域节点
                </span>
              )}
            </div>
            {canManageRegion && reg.code !== 'HQ' && (
              <button
                onClick={() => {
                  setEditingRegion(reg);
                  setSelectedManagerId(reg.manager_user_id ? String(reg.manager_user_id) : '');
                }}
                className="text-xs font-medium text-brand-700 hover:text-brand-800 flex items-center gap-1 px-2.5 py-1 rounded-lg hover:bg-brand-50"
              >
                <UserCog className="w-3.5 h-3.5" /> 调整区域负责人
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {reg.hotels.map((h) => (
              <div key={h.id} className="bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-base text-stone-900">{h.name}</span>
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-stone-100 text-stone-600">
                        {h.code}
                      </span>
                      {!h.is_hq && <StatusBadge status={h.status} />}
                    </div>
                    <div className="text-xs text-stone-500 mt-1 flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" /> {h.city}{h.district ? ` · ${h.district}` : ''} · {h.address}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 mt-1 flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Phone className="w-3.5 h-3.5" /> {h.phone}
                      </span>
                      {h.manager_name && <span>店长：{h.manager_name}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs text-stone-500">在编人数</div>
                    <div className="text-lg font-bold text-brand-700 flex items-center justify-end gap-1">
                      <Users className="w-4 h-4" /> {h.employee_count}
                    </div>
                    {!h.is_hq && (
                      <div className="mt-1.5 flex items-center justify-end gap-1.5 flex-wrap">
                        <span className="text-[11px] text-stone-400">{h.room_count} 间客房</span>
                        {['HQ_ADMIN', 'GENERAL_MANAGER', 'HR_MANAGER'].includes(user?.role || '') &&
                          hotelStatuses.length > 0 &&
                          h.status !== 'CLOSED' && (
                            <select
                              value={h.status}
                              onChange={(e) => handleStatusChange(h.id, e.target.value)}
                              className="text-[11px] px-1.5 py-0.5 rounded border border-stone-200 bg-white text-stone-700"
                            >
                              {hotelStatuses
                                .filter((st) => st.code !== 'CLOSED')
                                .map((st) => (
                                  <option key={st.code} value={st.code}>
                                    {st.label}
                                  </option>
                                ))}
                            </select>
                          )}
                        {['HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'].includes(user?.role || '') &&
                          h.status !== 'CLOSED' && (
                            <button
                              type="button"
                              onClick={() => {
                                setClosingHotel(h);
                                setCloseReason('');
                              }}
                              className="text-[11px] px-2 py-0.5 rounded border border-rose-200 text-rose-700 hover:bg-rose-50"
                            >
                              申请关闭
                            </button>
                          )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-3 border-t border-stone-100">
                  {h.departments.map((d) => (
                    <span
                      key={d.id}
                      className="px-2.5 py-1 rounded-lg bg-stone-50 border border-stone-200 text-xs text-stone-700"
                    >
                      {d.name} <strong className="text-stone-900">{d.employee_count}</strong>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <Modal open={open} onClose={() => setOpen(false)} title="新增连锁门店">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">门店编码</label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="如 NJ-XJK"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">门店名称</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如 南京新街口精品店"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属大区 *</label>
              <select
                value={regionId}
                onChange={(e) => {
                  const rid = Number(e.target.value);
                  setRegionId(rid);
                  const firstCity = cities.find((c) => c.region_id === rid);
                  setCityId(firstCity?.id || 0);
                  const firstDist = firstCity ? districts.find((d) => d.city_id === firstCity.id) : undefined;
                  setDistrictId(firstDist?.id || 0);
                }}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                required
              >
                {regionOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所在城市 *</label>
              <select
                value={cityId}
                onChange={(e) => {
                  const cid = Number(e.target.value);
                  setCityId(cid);
                  const firstDist = districts.find((d) => d.city_id === cid);
                  setDistrictId(firstDist?.id || 0);
                }}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                required
              >
                {cities
                  .filter((c) => c.region_id === regionId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所在城区</label>
              <select
                value={districtId}
                onChange={(e) => setDistrictId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value={0}>不限/待定</option>
                {districts
                  .filter((d) => d.city_id === cityId)
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
              <label className="block text-xs font-medium text-stone-700 mb-1">门店状态 *</label>
              <select
                value={hotelStatus}
                onChange={(e) => setHotelStatus(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                required
              >
                {(hotelStatuses.length > 0
                  ? hotelStatuses
                  : [
                      { code: 'CONTRACTED', label: '签约' },
                      { code: 'RENOVATING', label: '装修' },
                      { code: 'SOFT_OPENING', label: '试营业' },
                      { code: 'OPEN', label: '开业' },
                      { code: 'SUSPENDED', label: '停业整顿' },
                    ]
                )
                  .filter((st) => st.code !== 'CLOSED')
                  .map((st) => (
                    <option key={st.code} value={st.code}>
                      {st.label}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">客房数</label>
              <input
                type="number"
                value={roomCount}
                onChange={(e) => setRoomCount(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">门店地址</label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">联系电话</label>
              <input
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">
              预算模板门店（可选，复制当月与次月预算）
            </label>
            <select
              value={budgetTemplateHotelId}
              onChange={(e) => setBudgetTemplateHotelId(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
            >
              <option value={0}>不初始化预算（提交报销将提示「未设置预算」）</option>
              {regions
                .flatMap((r) => r.hotels)
                .filter((h) => !h.is_hq)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({h.code})
                  </option>
                ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="px-4 py-2 rounded-xl border border-stone-200 text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              创建门店
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(editingRegion)}
        onClose={() => setEditingRegion(null)}
        title={`调整区域负责人 · ${editingRegion?.name || ''}`}
        subtitle="若指定集团总经理兼任区域负责人，系统将在该大区的所有审批流中自动跳过区域经理节点，直达总经理审批"
      >
        <form onSubmit={handleSaveRegionManager} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">选择区域负责人</label>
            <select
              value={selectedManagerId}
              onChange={(e) => setSelectedManagerId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
            >
              <option value="">未指定</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}（{c.role === 'GENERAL_MANAGER' ? '集团总经理 · 兼任将跳过区域节点' : '区域经理'} · @{c.username}）
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingRegion(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存配置
            </button>
          </div>
        </form>
      </Modal>

      {closureRequests.length > 0 && (
        <div className="bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-stone-900">门店关闭审批单</h2>
              <p className="text-xs text-stone-500 mt-0.5">
                须门店全部员工为离职状态，并经区域总及集团总经理依次批准后门店状态方可变为关闭
              </p>
            </div>
            <span className="text-xs px-2.5 py-1 rounded-full bg-stone-100 text-stone-600 font-medium">
              共 {closureRequests.length} 条
            </span>
          </div>
          <div className="divide-y divide-stone-100">
            {closureRequests.map((reqItem) => (
              <div key={reqItem.id} className="py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-stone-500">{reqItem.request_no}</span>
                    <span className="font-semibold text-sm text-stone-900">
                      {reqItem.hotel_name} ({reqItem.hotel_code})
                    </span>
                    <StatusBadge status={reqItem.status} />
                    <span className="text-xs text-stone-500">{reqItem.status_detail}</span>
                  </div>
                  <div className="text-xs text-stone-600">
                    申请人：{reqItem.applicant_name} · 关店原因：{reqItem.reason} · 在职员工：{reqItem.non_resigned_employee_count} 人
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {reqItem.steps.map((st) => (
                      <span
                        key={st.step_order}
                        className={`text-[11px] px-2 py-0.5 rounded border ${
                          st.status === 'APPROVED'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : st.status === 'REJECTED'
                              ? 'bg-rose-50 text-rose-700 border-rose-200'
                              : st.status === 'PENDING'
                                ? 'bg-amber-50 text-amber-800 border-amber-200'
                                : 'bg-stone-50 text-stone-500 border-stone-200'
                        }`}
                      >
                        {st.step_order}. {st.step_name}
                        {st.approver_name ? `（${st.approver_name}）` : ''}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {reqItem.can_approve && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleClosureAction(reqItem.id, 'APPROVE')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold"
                      >
                        同意
                      </button>
                      <button
                        type="button"
                        onClick={() => handleClosureAction(reqItem.id, 'REJECT')}
                        className="px-3 py-1.5 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold"
                      >
                        驳回
                      </button>
                    </>
                  )}
                  {reqItem.status === 'PENDING_APPROVAL' &&
                    (Number(reqItem.applicant_id) === Number(user?.id) || user?.role === 'HQ_ADMIN') && (
                      <button
                        type="button"
                        onClick={() => handleCancelClosure(reqItem.id)}
                        className="px-3 py-1.5 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 text-xs"
                      >
                        撤销
                      </button>
                    )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal
        open={Boolean(closingHotel)}
        onClose={() => setClosingHotel(null)}
        title={`申请关闭门店 · ${closingHotel?.name || ''}`}
        subtitle="门店关闭前必须确认所有员工已办理离职，并经区域总及集团总经理批准"
      >
        <form onSubmit={handleRequestClosure} className="space-y-4">
          {closingHotel && closingHotel.employee_count > 0 && (
            <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
              当前门店仍有 {closingHotel.employee_count} 名在职/试用期员工，请先在「员工档案与离职」中办理全部员工离职并完成档案归档后再提交关闭申请。
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">关店原因 *</label>
            <textarea
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              rows={3}
              placeholder="请填写门店关闭原因、租约到期或合并调整说明"
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setClosingHotel(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={Boolean(closingHotel && closingHotel.employee_count > 0)}
              className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-sm font-semibold"
            >
              提交关店审批
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
