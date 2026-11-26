import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Building2, Edit3, History, MapPin, Plus, ShieldAlert, Trash2, Users } from 'lucide-react';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';

interface RegionItem {
  id: number;
  code: string;
  name: string;
  sort_order: number;
  ref_count: number;
  ref_detail: string;
}

interface CityItem {
  id: number;
  region_id: number;
  region_name: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: number;
  ref_count: number;
  ref_detail: string;
}

interface DistrictItem {
  id: number;
  city_id: number;
  city_name: string;
  region_name: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: number;
  ref_count: number;
  ref_detail: string;
}

interface DeptTemplateItem {
  id: number;
  org_level: 'HQ' | 'REGION' | 'STORE';
  code: string;
  name: string;
  category: string;
  sort_order: number;
  is_active: number;
  ref_count: number;
  ref_detail: string;
}

interface PositionItem {
  id: number;
  org_level: 'HQ' | 'REGION' | 'STORE';
  dept_template_id: number;
  dept_name: string;
  code: string;
  name: string;
  sort_order: number;
  is_active: number;
  ref_count: number;
  ref_detail: string;
}

interface DictItem {
  id: number;
  dict_type: string;
  code: string;
  label: string;
  sort_order: number;
  is_active: number;
  is_system: number;
  ref_count: number;
  ref_detail: string;
}

interface DictCategory {
  type: string;
  label: string;
  description: string;
}

interface AuditLogRow {
  id: number;
  entity_type: string;
  entity_id: number;
  entity_label: string;
  action: string;
  before_data: string | null;
  after_data: string | null;
  operator_name: string;
  operator_role: string;
  created_at: string;
}

const LEVEL_LABELS: Record<'HQ' | 'REGION' | 'STORE', string> = {
  HQ: '集团总部',
  REGION: '大区级',
  STORE: '门店级',
};

const DEPT_CATEGORIES = [
  { value: 'FRONT_OFFICE', label: '前厅运营' },
  { value: 'HOUSEKEEPING', label: '客房管理' },
  { value: 'ENGINEERING', label: '工程维保' },
  { value: 'FB', label: '餐饮服务' },
  { value: 'ADMIN', label: '综合职能' },
];

export function SystemConfigPage() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isAdmin = user?.role === 'HQ_ADMIN';

  const [tab, setTab] = useState<'geo' | 'depts' | 'positions' | 'dicts' | 'logs'>('geo');
  const [loading, setLoading] = useState(true);

  const [regions, setRegions] = useState<RegionItem[]>([]);
  const [cities, setCities] = useState<CityItem[]>([]);
  const [districts, setDistricts] = useState<DistrictItem[]>([]);
  const [deptTemplates, setDeptTemplates] = useState<DeptTemplateItem[]>([]);
  const [jobPositions, setJobPositions] = useState<PositionItem[]>([]);
  const [dictItems, setDictItems] = useState<DictItem[]>([]);
  const [dictCategories, setDictCategories] = useState<DictCategory[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);

  // Filters
  const [selectedRegionFilter, setSelectedRegionFilter] = useState<number | ''>('');
  const [selectedCityFilter, setSelectedCityFilter] = useState<number | ''>('');
  const [deptLevel, setDeptLevel] = useState<'HQ' | 'REGION' | 'STORE'>('HQ');
  const [posLevel, setPosLevel] = useState<'HQ' | 'REGION' | 'STORE'>('HQ');
  const [posDeptFilter, setPosDeptFilter] = useState<number | ''>('');
  const [activeDictType, setActiveDictType] = useState('HOTEL_STATUS');
  const [logKeyword, setLogKeyword] = useState('');

  // Modal state
  const [modalKind, setModalKind] = useState<
    null | 'region' | 'city' | 'district' | 'dept' | 'position' | 'dict'
  >(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [fCode, setFCode] = useState('');
  const [fName, setFName] = useState('');
  const [fParentId, setFParentId] = useState<number>(0);
  const [fCategory, setFCategory] = useState('ADMIN');
  const [fLevel, setFLevel] = useState<'HQ' | 'REGION' | 'STORE'>('HQ');
  const [fSort, setFSort] = useState(1);
  const [fActive, setFActive] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiFetch<{
        regions: RegionItem[];
        cities: CityItem[];
        districts: DistrictItem[];
        deptTemplates: DeptTemplateItem[];
        jobPositions: PositionItem[];
        dictItems: DictItem[];
        dictCategories: DictCategory[];
      }>('/api/master-data/all');
      setRegions(d.regions);
      setCities(d.cities);
      setDistricts(d.districts);
      setDeptTemplates(d.deptTemplates);
      setJobPositions(d.jobPositions);
      setDictItems(d.dictItems);
      setDictCategories(d.dictCategories);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载基础数据失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (logKeyword.trim()) params.set('keyword', logKeyword.trim());
      const d = await apiFetch<{ logs: AuditLogRow[] }>(`/api/master-data/audit-logs?${params.toString()}`);
      setLogs(d.logs);
    } catch {
      setLogs([]);
    }
  }, [logKeyword]);

  useEffect(() => {
    loadAll();
  }, [loadAll, user?.id]);

  useEffect(() => {
    if (tab === 'logs') loadLogs();
  }, [tab, loadLogs]);

  if (!isAdmin) {
    return (
      <div className="bg-white rounded-2xl border border-stone-200 p-10 text-center space-y-2">
        <ShieldAlert className="w-8 h-8 text-rose-500 mx-auto" />
        <div className="text-base font-semibold text-stone-900">仅集团系统管理员（HQ_ADMIN）可访问系统配置</div>
        <p className="text-xs text-stone-500">请切换至张景行（admin）账号维护大区、城市、城区、部门、职位及基础数据字典</p>
      </div>
    );
  }

  const openModal = (
    kind: 'region' | 'city' | 'district' | 'dept' | 'position' | 'dict',
    item?: any
  ) => {
    setModalKind(kind);
    setEditingId(item?.id ?? null);
    setFCode(item?.code || '');
    setFName(item?.name || item?.label || '');
    setFSort(item?.sort_order ?? 1);
    setFActive(item ? Boolean(item.is_active ?? 1) : true);
    if (kind === 'city') {
      setFParentId(item?.region_id || regions.find((r) => r.code !== 'HQ')?.id || regions[0]?.id || 0);
    } else if (kind === 'district') {
      setFParentId(item?.city_id || cities[0]?.id || 0);
    } else if (kind === 'dept') {
      setFLevel(item?.org_level || deptLevel);
      setFCategory(item?.category || 'ADMIN');
    } else if (kind === 'position') {
      const lvl = item?.org_level || posLevel;
      setFLevel(lvl);
      const matchingDepts = deptTemplates.filter((dt) => dt.org_level === lvl);
      setFParentId(item?.dept_template_id || matchingDepts[0]?.id || 0);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (modalKind === 'region') {
        await apiFetch(editingId ? `/api/master-data/regions/${editingId}` : '/api/master-data/regions', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ code: fCode, name: fName }),
        });
      } else if (modalKind === 'city') {
        await apiFetch(editingId ? `/api/master-data/cities/${editingId}` : '/api/master-data/cities', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ region_id: fParentId, code: fCode, name: fName, is_active: fActive }),
        });
      } else if (modalKind === 'district') {
        await apiFetch(editingId ? `/api/master-data/districts/${editingId}` : '/api/master-data/districts', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ city_id: fParentId, code: fCode, name: fName, is_active: fActive }),
        });
      } else if (modalKind === 'dept') {
        await apiFetch(editingId ? `/api/master-data/dept-templates/${editingId}` : '/api/master-data/dept-templates', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ org_level: fLevel, code: fCode, name: fName, category: fCategory, is_active: fActive }),
        });
      } else if (modalKind === 'position') {
        await apiFetch(editingId ? `/api/master-data/positions/${editingId}` : '/api/master-data/positions', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ org_level: fLevel, dept_template_id: fParentId, code: fCode, name: fName, is_active: fActive }),
        });
      } else if (modalKind === 'dict') {
        await apiFetch(editingId ? `/api/master-data/dicts/${editingId}` : '/api/master-data/dicts', {
          method: editingId ? 'PUT' : 'POST',
          body: JSON.stringify({ dict_type: activeDictType, code: fCode, label: fName, is_active: fActive }),
        });
      }
      showToast(editingId ? '基础数据已更新并记入回溯日志' : '基础数据已新增并记入回溯日志');
      setModalKind(null);
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', 'error');
    }
  };

  const handleDelete = async (endpoint: string, label: string) => {
    if (!window.confirm(`确认删除「${label}」？`)) return;
    try {
      await apiFetch(endpoint, { method: 'DELETE' });
      showToast('已删除并记录回溯日志');
      await loadAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '删除失败', 'error');
    }
  };

  const filteredCities = selectedRegionFilter ? cities.filter((c) => c.region_id === selectedRegionFilter) : cities;
  const filteredDistricts = selectedCityFilter
    ? districts.filter((d) => d.city_id === selectedCityFilter)
    : selectedRegionFilter
      ? districts.filter((d) => cities.some((c) => c.id === d.city_id && c.region_id === selectedRegionFilter))
      : districts;

  const currentDictMeta = dictCategories.find((c) => c.type === activeDictType);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">系统配置与基础数据管理</h1>
        <p className="text-sm text-stone-500 mt-0.5">
          由集团管理员统一维护大区/城市/城区、三级组织部门、部门职位及业务字典（有关联数据时禁止直接删除，所有变更全程回溯）
        </p>
      </div>

      <div className="flex items-center gap-1.5 bg-stone-200/60 p-1 rounded-xl w-fit flex-wrap">
        {[
          { key: 'geo', label: '大区 / 城市 / 城区', icon: <MapPin className="w-3.5 h-3.5" /> },
          { key: 'depts', label: '组织部门库（总部/大区/门店）', icon: <Building2 className="w-3.5 h-3.5" /> },
          { key: 'positions', label: '部门职位库（分级独立维护）', icon: <Users className="w-3.5 h-3.5" /> },
          { key: 'dicts', label: '基础数据字典', icon: <BookOpen className="w-3.5 h-3.5" /> },
          { key: 'logs', label: '变更回溯日志', icon: <History className="w-3.5 h-3.5" /> },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key as typeof tab)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
              tab === t.key ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
            }`}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-white rounded-2xl border border-stone-200 p-12 text-center text-sm text-stone-400">
          正在加载基础数据...
        </div>
      ) : (
        <>
          {tab === 'geo' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              {/* Regions */}
              <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm text-stone-900">1. 大区 ({regions.length})</h2>
                  <button
                    onClick={() => openModal('region')}
                    className="px-2.5 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> 新增大区
                  </button>
                </div>
                <div className="divide-y divide-stone-100">
                  {regions.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => {
                        setSelectedRegionFilter((prev) => (prev === r.id ? '' : r.id));
                        setSelectedCityFilter('');
                      }}
                      className={`py-2.5 px-2 rounded-lg cursor-pointer flex items-center justify-between gap-2 ${
                        selectedRegionFilter === r.id ? 'bg-brand-50' : 'hover:bg-stone-50'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium text-stone-900">
                          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-stone-100 text-[11px] font-mono text-stone-500">
                            #{r.sort_order}
                          </span>
                          {r.name} <span className="text-xs font-mono text-stone-400">{r.code}</span>
                        </div>
                        {r.ref_detail && <div className="text-[11px] text-stone-400">{r.ref_detail}</div>}
                      </div>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => openModal('region', r)}
                          className="p-1.5 text-stone-500 hover:text-brand-700"
                          title="编辑"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={r.ref_count > 0}
                          onClick={() => handleDelete(`/api/master-data/regions/${r.id}`, r.name)}
                          className="p-1.5 text-stone-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed"
                          title={r.ref_count > 0 ? `有关联数据禁止删除：${r.ref_detail}` : '删除'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Cities */}
              <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm text-stone-900">2. 城市 ({filteredCities.length})</h2>
                  <button
                    onClick={() => openModal('city')}
                    className="px-2.5 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> 新增城市
                  </button>
                </div>
                <div className="divide-y divide-stone-100 max-h-[480px] overflow-y-auto">
                  {filteredCities.map((c) => (
                    <div
                      key={c.id}
                      onClick={() => setSelectedCityFilter((prev) => (prev === c.id ? '' : c.id))}
                      className={`py-2.5 px-2 rounded-lg cursor-pointer flex items-center justify-between gap-2 ${
                        selectedCityFilter === c.id ? 'bg-brand-50' : 'hover:bg-stone-50'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-medium text-stone-900">
                          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-stone-100 text-[11px] font-mono text-stone-500">
                            #{c.sort_order}
                          </span>
                          {c.name} <span className="text-xs font-mono text-stone-400">{c.code}</span>
                          {!c.is_active && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">停用</span>}
                        </div>
                        <div className="text-[11px] text-stone-400">
                          {c.region_name}{c.ref_detail ? ` · ${c.ref_detail}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openModal('city', c)} className="p-1.5 text-stone-500 hover:text-brand-700">
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={c.ref_count > 0}
                          onClick={() => handleDelete(`/api/master-data/cities/${c.id}`, c.name)}
                          className="p-1.5 text-stone-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed"
                          title={c.ref_count > 0 ? `有关联数据禁止删除：${c.ref_detail}` : '删除'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Districts */}
              <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-sm text-stone-900">3. 城区 ({filteredDistricts.length})</h2>
                  <button
                    onClick={() => openModal('district')}
                    className="px-2.5 py-1 rounded-lg bg-brand-600 text-white text-xs font-medium flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> 新增城区
                  </button>
                </div>
                <div className="divide-y divide-stone-100 max-h-[480px] overflow-y-auto">
                  {filteredDistricts.map((d) => (
                    <div key={d.id} className="py-2.5 px-2 rounded-lg hover:bg-stone-50 flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-stone-900">
                          <span className="inline-block mr-1.5 px-1.5 py-0.5 rounded bg-stone-100 text-[11px] font-mono text-stone-500">
                            #{d.sort_order}
                          </span>
                          {d.name} <span className="text-xs font-mono text-stone-400">{d.code}</span>
                          {!d.is_active && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">停用</span>}
                        </div>
                        <div className="text-[11px] text-stone-400">
                          {d.region_name} / {d.city_name}{d.ref_detail ? ` · ${d.ref_detail}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => openModal('district', d)} className="p-1.5 text-stone-500 hover:text-brand-700">
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={d.ref_count > 0}
                          onClick={() => handleDelete(`/api/master-data/districts/${d.id}`, d.name)}
                          className="p-1.5 text-stone-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed"
                          title={d.ref_count > 0 ? `有关联数据禁止删除：${d.ref_detail}` : '删除'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'depts' && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl">
                  {(['HQ', 'REGION', 'STORE'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      onClick={() => setDeptLevel(lvl)}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                        deptLevel === lvl ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
                      }`}
                    >
                      {LEVEL_LABELS[lvl]}部门 ({deptTemplates.filter((d) => d.org_level === lvl).length})
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => openModal('dept')}
                  className="px-3.5 py-1.5 rounded-xl bg-brand-600 text-white text-xs font-semibold flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> 新增{LEVEL_LABELS[deptLevel]}部门
                </button>
              </div>

              <table className="w-full text-sm text-left">
                <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-3">序号</th>
                    <th className="px-4 py-3">部门编码</th>
                    <th className="px-4 py-3">部门名称</th>
                    <th className="px-4 py-3">职能分类</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">关联说明</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {deptTemplates
                    .filter((d) => d.org_level === deptLevel)
                    .map((d) => (
                      <tr key={d.id} className="hover:bg-stone-50/70">
                        <td className="px-4 py-3 font-mono text-xs text-stone-500">{d.sort_order}</td>
                        <td className="px-4 py-3 font-mono text-xs">{d.code}</td>
                        <td className="px-4 py-3 font-semibold text-stone-900">{d.name}</td>
                        <td className="px-4 py-3 text-xs text-stone-600">
                          {DEPT_CATEGORIES.find((c) => c.value === d.category)?.label || d.category}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className={`px-2 py-0.5 rounded-full ${d.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
                            {d.is_active ? '启用' : '停用'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-stone-400">{d.ref_detail || '未关联'}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button onClick={() => openModal('dept', d)} className="text-xs text-brand-700 hover:underline">
                            编辑
                          </button>
                          <button
                            disabled={d.ref_count > 0}
                            onClick={() => handleDelete(`/api/master-data/dept-templates/${d.id}`, d.name)}
                            className="text-xs text-rose-600 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
                            title={d.ref_count > 0 ? d.ref_detail : '删除'}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'positions' && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-1.5 bg-stone-100 p-1 rounded-xl">
                    {(['HQ', 'REGION', 'STORE'] as const).map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() => {
                          setPosLevel(lvl);
                          setPosDeptFilter('');
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                          posLevel === lvl ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600'
                        }`}
                      >
                        {LEVEL_LABELS[lvl]}职位 ({jobPositions.filter((p) => p.org_level === lvl).length})
                      </button>
                    ))}
                  </div>
                  <select
                    value={posDeptFilter}
                    onChange={(e) => setPosDeptFilter(e.target.value ? Number(e.target.value) : '')}
                    className="px-3 py-1.5 rounded-xl border border-stone-200 text-xs bg-white"
                  >
                    <option value="">全部{LEVEL_LABELS[posLevel]}部门</option>
                    {deptTemplates
                      .filter((d) => d.org_level === posLevel)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                  </select>
                </div>
                <button
                  onClick={() => openModal('position')}
                  className="px-3.5 py-1.5 rounded-xl bg-brand-600 text-white text-xs font-semibold flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> 新增{LEVEL_LABELS[posLevel]}职位
                </button>
              </div>

              <table className="w-full text-sm text-left">
                <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                  <tr>
                    <th className="px-4 py-3">序号</th>
                    <th className="px-4 py-3">所属层级 / 部门</th>
                    <th className="px-4 py-3">职位编码</th>
                    <th className="px-4 py-3">职位名称</th>
                    <th className="px-4 py-3">状态</th>
                    <th className="px-4 py-3">关联说明</th>
                    <th className="px-4 py-3 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {jobPositions
                    .filter((p) => p.org_level === posLevel && (!posDeptFilter || p.dept_template_id === posDeptFilter))
                    .map((p) => (
                      <tr key={p.id} className="hover:bg-stone-50/70">
                        <td className="px-4 py-3 font-mono text-xs text-stone-500">{p.sort_order}</td>
                        <td className="px-4 py-3 text-xs text-stone-600">
                          {LEVEL_LABELS[p.org_level]} · {p.dept_name}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{p.code}</td>
                        <td className="px-4 py-3 font-semibold text-stone-900">{p.name}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className={`px-2 py-0.5 rounded-full ${p.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
                            {p.is_active ? '启用' : '停用'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-stone-400">{p.ref_detail || '未关联'}</td>
                        <td className="px-4 py-3 text-right space-x-2">
                          <button onClick={() => openModal('position', p)} className="text-xs text-brand-700 hover:underline">
                            编辑
                          </button>
                          <button
                            disabled={p.ref_count > 0}
                            onClick={() => handleDelete(`/api/master-data/positions/${p.id}`, p.name)}
                            className="text-xs text-rose-600 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
                            title={p.ref_count > 0 ? p.ref_detail : '删除'}
                          >
                            删除
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'dicts' && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-4 bg-white rounded-2xl border border-stone-200 shadow-sm p-3 space-y-1">
                <div className="px-2 py-1.5 text-xs font-semibold text-stone-400 uppercase">基础字典分类</div>
                {dictCategories.map((c) => (
                  <button
                    key={c.type}
                    onClick={() => setActiveDictType(c.type)}
                    className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-colors flex items-center justify-between ${
                      activeDictType === c.type
                        ? 'bg-brand-50 text-brand-800 font-semibold border border-brand-200'
                        : 'text-stone-700 hover:bg-stone-50'
                    }`}
                  >
                    <span>{c.label}</span>
                    <span className="text-[11px] text-stone-400">
                      {dictItems.filter((i) => i.dict_type === c.type).length}
                    </span>
                  </button>
                ))}
              </div>

              <div className="lg:col-span-8 bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-base text-stone-900">{currentDictMeta?.label}</h2>
                    <p className="text-xs text-stone-500">{currentDictMeta?.description}</p>
                  </div>
                  <button
                    onClick={() => openModal('dict')}
                    className="px-3.5 py-1.5 rounded-xl bg-brand-600 text-white text-xs font-semibold flex items-center gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" /> 新增字典项
                  </button>
                </div>

                <table className="w-full text-sm text-left">
                  <thead className="bg-stone-50 border-b border-stone-200 text-xs text-stone-500">
                    <tr>
                      <th className="px-4 py-3">序号</th>
                      <th className="px-4 py-3">编码</th>
                      <th className="px-4 py-3">显示名称</th>
                      <th className="px-4 py-3">状态</th>
                      <th className="px-4 py-3">关联说明</th>
                      <th className="px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {dictItems
                      .filter((d) => d.dict_type === activeDictType)
                      .map((d) => (
                        <tr key={d.id} className="hover:bg-stone-50/70">
                          <td className="px-4 py-3 font-mono text-xs text-stone-500">{d.sort_order}</td>
                          <td className="px-4 py-3 font-mono text-xs">{d.code}</td>
                          <td className="px-4 py-3 font-semibold text-stone-900">{d.label}</td>
                          <td className="px-4 py-3 text-xs">
                            <span className={`px-2 py-0.5 rounded-full ${d.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-stone-100 text-stone-500'}`}>
                              {d.is_active ? '启用' : '停用'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-stone-400">
                            {d.is_system ? '系统核心项' : d.ref_detail || '未关联'}
                          </td>
                          <td className="px-4 py-3 text-right space-x-2">
                            <button onClick={() => openModal('dict', d)} className="text-xs text-brand-700 hover:underline">
                              编辑
                            </button>
                            <button
                              disabled={d.ref_count > 0 || Boolean(d.is_system)}
                              onClick={() => handleDelete(`/api/master-data/dicts/${d.id}`, d.label)}
                              className="text-xs text-rose-600 hover:underline disabled:opacity-30 disabled:cursor-not-allowed"
                              title={d.is_system ? '系统核心字典禁止删除' : d.ref_count > 0 ? d.ref_detail : '删除'}
                            >
                              删除
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'logs' && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-base text-stone-900">基础数据变更回溯日志</h2>
                  <p className="text-xs text-stone-500">完整记录每次新增、修改与删除前后的字段快照</p>
                </div>
                <input
                  type="text"
                  value={logKeyword}
                  onChange={(e) => setLogKeyword(e.target.value)}
                  placeholder="搜实体名称 / 操作人 / 字段值"
                  className="px-3 py-1.5 rounded-xl border border-stone-200 text-xs w-64"
                />
              </div>
              <div className="divide-y divide-stone-100">
                {logs.map((l) => (
                  <div key={l.id} className="py-3 space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded-full font-semibold ${
                            l.action === 'CREATE'
                              ? 'bg-emerald-50 text-emerald-700'
                              : l.action === 'UPDATE'
                                ? 'bg-amber-50 text-amber-700'
                                : 'bg-rose-50 text-rose-700'
                          }`}
                        >
                          {l.action}
                        </span>
                        <span className="font-mono text-stone-500">{l.entity_type}</span>
                        <span className="font-semibold text-stone-900">{l.entity_label}</span>
                      </div>
                      <span className="text-stone-400">
                        {l.operator_name} · {l.created_at}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px]">
                      <div className="p-2 rounded-lg bg-stone-50 border border-stone-200 text-stone-600 break-all">
                        <span className="font-sans font-semibold text-stone-500 mr-1">变更前：</span>
                        {l.before_data || '（无）'}
                      </div>
                      <div className="p-2 rounded-lg bg-stone-50 border border-stone-200 text-stone-800 break-all">
                        <span className="font-sans font-semibold text-stone-500 mr-1">变更后：</span>
                        {l.after_data || '（已删除）'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(modalKind)}
        onClose={() => setModalKind(null)}
        title={editingId ? '编辑基础数据' : '新增基础数据'}
      >
        <form onSubmit={handleSave} className="space-y-4">
          {modalKind === 'city' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属大区</label>
              <select
                value={fParentId}
                onChange={(e) => setFParentId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                required
              >
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {modalKind === 'district' && (
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">所属城市</label>
              <select
                value={fParentId}
                onChange={(e) => setFParentId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                required
              >
                {cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.region_name} / {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(modalKind === 'dept' || modalKind === 'position') && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">所属组织层级</label>
                <select
                  value={fLevel}
                  onChange={(e) => {
                    const nextLvl = e.target.value as 'HQ' | 'REGION' | 'STORE';
                    setFLevel(nextLvl);
                    if (modalKind === 'position') {
                      const firstDept = deptTemplates.find((dt) => dt.org_level === nextLvl);
                      setFParentId(firstDept?.id || 0);
                    }
                  }}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                >
                  <option value="HQ">集团总部</option>
                  <option value="REGION">大区级</option>
                  <option value="STORE">门店级</option>
                </select>
              </div>
              {modalKind === 'dept' ? (
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">职能分类</label>
                  <select
                    value={fCategory}
                    onChange={(e) => setFCategory(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                  >
                    {DEPT_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">所属部门</label>
                  <select
                    value={fParentId}
                    onChange={(e) => setFParentId(Number(e.target.value))}
                    className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm bg-white"
                    required
                  >
                    {deptTemplates
                      .filter((dt) => dt.org_level === fLevel)
                      .map((dt) => (
                        <option key={dt.id} value={dt.id}>
                          {dt.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">编码 *</label>
              <input
                type="text"
                value={fCode}
                onChange={(e) => setFCode(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm font-mono"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-stone-700 mb-1">名称 *</label>
              <input
                type="text"
                value={fName}
                onChange={(e) => setFName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-stone-300 text-sm"
                required
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="text-xs text-stone-500">
              {editingId ? (
                <span>
                  当前序号：<span className="font-mono font-semibold text-stone-800">#{fSort}</span>（系统自动分配，不可修改）
                </span>
              ) : (
                <span>序号将按当前最大值自动递增分配，删除后不重用</span>
              )}
            </div>
            {modalKind !== 'region' && (
              <label className="flex items-center gap-2 text-sm text-stone-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={fActive}
                  onChange={(e) => setFActive(e.target.checked)}
                  className="rounded text-brand-600"
                />
                <span>启用状态</span>
              </label>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setModalKind(null)}
              className="px-4 py-2 rounded-xl border border-stone-200 text-sm"
            >
              取消
            </button>
            <button type="submit" className="px-5 py-2 rounded-xl bg-brand-600 text-white text-sm font-semibold">
              保存
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
