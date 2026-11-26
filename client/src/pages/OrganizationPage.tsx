import React, { useEffect, useState } from 'react';
import { Building2, MapPin, Phone, Plus, Users } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';

interface RegionNode {
  id: number;
  code: string;
  name: string;
  hotels: Array<{
    id: number;
    code: string;
    name: string;
    city: string;
    address: string;
    phone: string;
    room_count: number;
    is_hq: number;
    manager_name: string | null;
    employee_count: number;
    departments: Array<{ id: number; name: string; employee_count: number }>;
  }>;
}

export function OrganizationPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [regions, setRegions] = useState<RegionNode[]>([]);
  const [open, setOpen] = useState(false);

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState(2);
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [roomCount, setRoomCount] = useState(120);

  const load = () => {
    apiFetch<{ regions: RegionNode[] }>('/api/organization/tree').then((d) => setRegions(d.regions));
  };

  useEffect(() => {
    load();
  }, [user?.id]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/organization/hotels', {
        method: 'POST',
        body: JSON.stringify({
          code,
          name,
          region_id: Number(regionId),
          city,
          address,
          phone,
          room_count: Number(roomCount),
        }),
      });
      showToast('新门店已创建并自动初始化部门架构');
      setOpen(false);
      setCode('');
      setName('');
      load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败', 'error');
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
          <div className="flex items-center gap-2 text-sm font-bold text-stone-700">
            <Building2 className="w-4 h-4 text-brand-600" />
            <span>{reg.name}</span>
            <span className="text-xs font-normal text-stone-400">({reg.hotels.length} 家机构)</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {reg.hotels.map((h) => (
              <div key={h.id} className="bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-base text-stone-900">{h.name}</span>
                      <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-stone-100 text-stone-600">
                        {h.code}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 mt-1 flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3.5 h-3.5" /> {h.city} · {h.address}
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
                    {!h.is_hq && <div className="text-[11px] text-stone-400">{h.room_count} 间客房</div>}
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
              <label className="block text-xs font-medium text-stone-700 mb-1">所属大区</label>
              <select
                value={regionId}
                onChange={(e) => setRegionId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value={2}>华东大区</option>
                <option value={3}>华北大区</option>
                <option value={4}>华南大区</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">城市</label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
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
    </div>
  );
}
