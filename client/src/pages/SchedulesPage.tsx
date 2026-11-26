import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { getMondayStr, SHIFT_OPTIONS } from '../lib/format';

interface ScheduleResponse {
  hotelId: number;
  weekStart: string;
  dates: string[];
  employees: Array<{
    id: number;
    emp_no: string;
    name: string;
    position: string;
    department_name: string;
  }>;
  shifts: Array<{
    id: number;
    employee_id: number;
    home_hotel_id: number;
    assigned_hotel_id: number;
    assigned_hotel_name: string;
    shift_date: string;
    shift_type: string;
    is_cross_store: number;
    notes: string | null;
  }>;
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function SchedulesPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const canEdit = ['HQ_ADMIN', 'HR_MANAGER', 'REGIONAL_MANAGER', 'STORE_MANAGER'].includes(
    user?.role || ''
  );

  const [hotels, setHotels] = useState<Array<{ id: number; name: string; is_hq: number }>>([]);
  const [allHotels, setAllHotels] = useState<Array<{ id: number; name: string }>>([]);
  const [hotelId, setHotelId] = useState<number>(user?.hotel_id && user.hotel_id !== 1 ? user.hotel_id : 2);
  const [weekOffset, setWeekOffset] = useState(0);
  const [data, setData] = useState<ScheduleResponse | null>(null);

  // Cell edit modal
  const [editing, setEditing] = useState<{
    employeeId: number;
    empName: string;
    date: string;
    shiftType: string;
    assignedHotelId: number;
    notes: string;
  } | null>(null);

  const weekStart = getMondayStr(weekOffset);

  const load = useCallback(async () => {
    const res = await apiFetch<ScheduleResponse>(
      `/api/schedules?hotelId=${hotelId}&weekStart=${weekStart}`
    );
    setData(res);
  }, [hotelId, weekStart]);

  useEffect(() => {
    apiFetch<{ hotels: Array<{ id: number; name: string; is_hq: number }> }>('/api/organization/hotels').then(
      (d) => {
        const branches = d.hotels.filter((h) => !h.is_hq);
        setHotels(branches.length > 0 ? branches : d.hotels);
        if (user?.hotel_id && user.hotel_id !== 1) setHotelId(user.hotel_id);
        else if (branches.length > 0) setHotelId(branches[0].id);
      }
    );
    apiFetch<{ hotels: Array<{ id: number; name: string }> }>('/api/organization/hotels?all=true').then(
      (d) => setAllHotels(d.hotels)
    );
  }, [user?.hotel_id]);

  useEffect(() => {
    if (hotelId) load();
  }, [load, hotelId]);

  const handleSaveCell = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await apiFetch('/api/schedules/assign', {
        method: 'PUT',
        body: JSON.stringify({
          assignments: [
            {
              employee_id: editing.employeeId,
              shift_date: editing.date,
              shift_type: editing.shiftType,
              assigned_hotel_id: editing.assignedHotelId,
              notes: editing.notes || null,
            },
          ],
        }),
      });
      showToast('排班已更新');
      setEditing(null);
      await load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '排班失败', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-900">酒店轮班排班表</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            支持早/中/晚/夜班四班倒排班与跨店支援调派（夜班自动联动月度夜班津贴核算）
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={hotelId}
            onChange={(e) => setHotelId(Number(e.target.value))}
            className="px-3 py-2 rounded-xl border border-stone-200 bg-white text-sm font-medium"
          >
            {hotels.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>

          <div className="flex items-center bg-white border border-stone-200 rounded-xl overflow-hidden">
            <button
              onClick={() => setWeekOffset((w) => w - 1)}
              className="p-2 hover:bg-stone-50 text-stone-600"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 text-xs font-semibold text-stone-700 tabular-nums">
              {weekStart} 起
            </span>
            <button
              onClick={() => setWeekOffset((w) => w + 1)}
              className="p-2 hover:bg-stone-50 text-stone-600"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Shift Legend */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {SHIFT_OPTIONS.map((opt) => (
          <span key={opt.value} className={`px-2.5 py-1 rounded-lg border font-medium ${opt.color}`}>
            {opt.label}
          </span>
        ))}
        <span className="px-2.5 py-1 rounded-lg border border-brand-200 bg-brand-50 text-brand-800 flex items-center gap-1">
          <ArrowLeftRight className="w-3.5 h-3.5" /> 跨店支援
        </span>
      </div>

      <div className="bg-white rounded-2xl border border-stone-200/90 shadow-sm overflow-x-auto">
        {data && (
          <table className="w-full text-sm text-left min-w-[820px]">
            <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
              <tr>
                <th className="px-4 py-3 w-44">员工 / 岗位</th>
                {data.dates.map((d, i) => (
                  <th key={d} className="px-3 py-3 text-center">
                    <div className="font-semibold text-stone-800">{WEEKDAYS[i]}</div>
                    <div className="text-[11px] text-stone-400 tabular-nums">{d.slice(5)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {data.employees.map((emp) => (
                <tr key={emp.id} className="hover:bg-stone-50/50">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-stone-900">{emp.name}</div>
                    <div className="text-xs text-stone-500">
                      {emp.department_name} · {emp.position}
                    </div>
                  </td>
                  {data.dates.map((d) => {
                    const s = data.shifts.find((x) => x.employee_id === emp.id && x.shift_date === d);
                    const meta = SHIFT_OPTIONS.find((o) => o.value === s?.shift_type);
                    return (
                      <td key={d} className="px-2 py-2.5 text-center">
                        <button
                          disabled={!canEdit}
                          onClick={() =>
                            setEditing({
                              employeeId: emp.id,
                              empName: emp.name,
                              date: d,
                              shiftType: s?.shift_type || 'MORNING',
                              assignedHotelId: s?.assigned_hotel_id || hotelId,
                              notes: s?.notes || '',
                            })
                          }
                          className={`w-full py-2 px-1.5 rounded-xl border text-xs font-medium transition-all ${
                            meta
                              ? meta.color
                              : 'bg-stone-50/60 border-dashed border-stone-200 text-stone-400'
                          } ${canEdit ? 'hover:ring-2 hover:ring-brand-300 cursor-pointer' : 'cursor-default'}`}
                        >
                          <div>{meta ? meta.label : '未排班'}</div>
                          {s?.is_cross_store === 1 && (
                            <div className="text-[10px] mt-0.5 text-brand-700 font-semibold truncate">
                              支援：{s.assigned_hotel_name}
                            </div>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing ? `排班调整 · ${editing.empName}` : ''}
        subtitle={editing ? `日期：${editing.date}` : ''}
      >
        {editing && (
          <form onSubmit={handleSaveCell} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1.5">选择班次</label>
              <div className="grid grid-cols-5 gap-2">
                {SHIFT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEditing({ ...editing, shiftType: opt.value })}
                    className={`py-2 rounded-xl border text-xs font-semibold ${
                      editing.shiftType === opt.value
                        ? 'ring-2 ring-brand-500 ' + opt.color
                        : 'bg-white border-stone-200 text-stone-600'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">执勤门店（可跨店支援）</label>
              <select
                value={editing.assignedHotelId}
                onChange={(e) => setEditing({ ...editing, assignedHotelId: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
              >
                {allHotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">排班备注</label>
              <input
                type="text"
                value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                placeholder="选填：如支援周末高峰"
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 rounded-xl border text-sm">
                取消
              </button>
              <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
                保存排班
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
