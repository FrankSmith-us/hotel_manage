import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, ShieldAlert, UserCheck, UserCog, UserX } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  role_label: string;
  employee_id: number | null;
  hotel_id: number | null;
  region_id: number | null;
  is_active: number;
  must_change_password: number;
  password_changed_at: string | null;
  hotel_name: string | null;
  region_name: string | null;
  emp_no: string | null;
  emp_status: string | null;
}

const ROLES = [
  { value: 'HQ_ADMIN', label: '集团系统管理员' },
  { value: 'CHAIRMAN', label: '董事长' },
  { value: 'GENERAL_MANAGER', label: '集团总经理' },
  { value: 'HR_MANAGER', label: '集团HR总监' },
  { value: 'FINANCE', label: '集团财务经理' },
  { value: 'REGIONAL_MANAGER', label: '区域经理' },
  { value: 'STORE_MANAGER', label: '门店店长' },
  { value: 'STAFF', label: '门店员工' },
];

export function UsersPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canAccess = ['HQ_ADMIN', 'HR_MANAGER'].includes(user?.role || '');

  const [users, setUsers] = useState<UserRow[]>([]);
  const [hotels, setHotels] = useState<Array<{ id: number; name: string }>>([]);
  const [regions, setRegions] = useState<Array<{ id: number; name: string }>>([]);
  const [keyword, setKeyword] = useState('');
  const [tempPassInfo, setTempPassInfo] = useState<{ username: string; password: string } | null>(null);

  // Role modal
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [rRole, setRRole] = useState('STAFF');
  const [rHotelId, setRHotelId] = useState<number | ''>('');
  const [rRegionId, setRRegionId] = useState<number | ''>('');

  const load = useCallback(async () => {
    if (!canAccess) return;
    const [uRes, hRes, rRes] = await Promise.all([
      apiFetch<{ users: UserRow[] }>('/api/users'),
      apiFetch<{ hotels: Array<{ id: number; name: string }> }>('/api/organization/hotels?all=true'),
      apiFetch<{ allRegions: Array<{ id: number; name: string }> }>('/api/master-data/options'),
    ]);
    setUsers(uRes.users);
    setHotels(hRes.hotels);
    setRegions(rRes.allRegions || []);
  }, [canAccess]);

  useEffect(() => {
    load();
  }, [load, user?.id]);

  if (!canAccess) {
    return (
      <div className="bg-white rounded-2xl border border-stone-200 p-10 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-rose-500 mx-auto" />
        <div className="text-base font-semibold text-stone-900">仅集团系统管理员或 HR 总监可管理账号权限</div>
      </div>
    );
  }

  const handleResetPassword = async (u: UserRow) => {
    if (!window.confirm(`确认重置账号 ${u.username}（${u.display_name}）的密码？`)) return;
    try {
      const res = await apiFetch<{ temp_password: string }>(`/api/users/${u.id}/reset-password`, {
        method: 'POST',
      });
      setTempPassInfo({ username: u.username, password: res.temp_password });
      showToast('已生成临时密码，请妥善告知员工');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '重置失败', 'error');
    }
  };

  const handleToggleStatus = async (u: UserRow) => {
    try {
      await apiFetch(`/api/users/${u.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: !u.is_active }),
      });
      showToast(u.is_active ? '账号已停用' : '账号已启用');
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '操作失败', 'error');
    }
  };

  const openRoleModal = (u: UserRow) => {
    setEditingUser(u);
    setRRole(u.role);
    setRHotelId(u.hotel_id || '');
    setRRegionId(u.region_id || '');
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      await apiFetch(`/api/users/${editingUser.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: rRole,
          hotel_id: rHotelId ? Number(rHotelId) : null,
          region_id: rRegionId ? Number(rRegionId) : null,
        }),
      });
      showToast('账号角色与归属已更新');
      setEditingUser(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '更新失败', 'error');
    }
  };

  const filtered = users.filter((u) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return [u.username, u.display_name, u.role_label, u.hotel_name || '', u.emp_no || ''].some((v) =>
      v.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">账号与权限管理</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            管理登录账号启停、角色分配及临时密码重置（重置后首次登录须修改密码）
          </p>
        </div>
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜用户名 / 姓名 / 门店"
          className="px-3.5 py-2 rounded-xl border border-stone-200 bg-white text-sm w-60"
        />
      </div>

      {tempPassInfo && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between text-sm">
          <div>
            账号 <span className="font-mono font-bold">{tempPassInfo.username}</span> 的临时密码已生成（仅显示一次）：
            <span className="ml-2 px-2.5 py-0.5 rounded bg-white border border-amber-300 font-mono font-bold text-stone-900">
              {tempPassInfo.password}
            </span>
          </div>
          <button onClick={() => setTempPassInfo(null)} className="text-xs text-stone-500 hover:underline">
            关闭提示
          </button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
              <tr>
                <th className="px-5 py-3.5">账号 / 姓名</th>
                <th className="px-4 py-3.5">角色</th>
                <th className="px-4 py-3.5">所属机构 / 大区</th>
                <th className="px-4 py-3.5">账号状态</th>
                <th className="px-4 py-3.5">改密状态</th>
                <th className="px-5 py-3.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {filtered.map((u) => (
                <tr key={u.id} className="hover:bg-stone-50/70">
                  <td className="px-5 py-3.5">
                    <div className="font-semibold text-stone-900">{u.display_name}</div>
                    <div className="text-xs text-stone-400 font-mono">
                      @{u.username}
                      {u.emp_no ? ` · ${u.emp_no}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-xs font-medium text-stone-800">{u.role_label}</td>
                  <td className="px-4 py-3.5 text-xs text-stone-600">
                    {u.hotel_name || u.region_name || '集团总部'}
                  </td>
                  <td className="px-4 py-3.5 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${
                        u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'
                      }`}
                    >
                      {u.is_active ? '启用中' : '已停用'}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-xs text-stone-500">
                    {u.must_change_password ? (
                      <span className="text-amber-700 font-medium">待首次改密</span>
                    ) : (
                      u.password_changed_at || '正常'
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-right space-x-2">
                    <button
                      onClick={() => openRoleModal(u)}
                      className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
                    >
                      <UserCog className="w-3.5 h-3.5" /> 角色/归属
                    </button>
                    <button
                      onClick={() => handleResetPassword(u)}
                      className="inline-flex items-center gap-1 text-xs text-amber-700 hover:underline"
                    >
                      <KeyRound className="w-3.5 h-3.5" /> 重置密码
                    </button>
                    <button
                      disabled={Number(u.id) === Number(user?.id)}
                      onClick={() => handleToggleStatus(u)}
                      className="inline-flex items-center gap-1 text-xs text-rose-600 hover:underline disabled:opacity-30"
                    >
                      {u.is_active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                      {u.is_active ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={Boolean(editingUser)} onClose={() => setEditingUser(null)} title="调整账号角色与机构归属">
        <form onSubmit={handleSaveRole} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-stone-700 mb-1">系统角色</label>
            <select
              value={rRole}
              onChange={(e) => setRRole(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属门店</label>
              <select
                value={rHotelId}
                onChange={(e) => setRHotelId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="">不绑定门店</option>
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属大区</label>
              <select
                value={rRegionId}
                onChange={(e) => setRRegionId(e.target.value ? Number(e.target.value) : '')}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                <option value="">不绑定大区</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditingUser(null)} className="px-4 py-2 rounded-xl border text-sm">
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存变更
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
