import React, { useState } from 'react';
import { Hotel, KeyRound, ShieldCheck, UserCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useToast } from '../components/Toast';

export function LoginPage() {
  const { login, switchDemoAccount, demoAccounts, demoSwitchEnabled } = useAuth();
  const { showToast } = useToast();
  const [username, setUsername] = useState('mgr_sh');
  const [password, setPassword] = useState('Hotel@2026');
  const [demoQuery, setDemoQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const filteredDemoAccounts = demoAccounts.filter((acc) => {
    const q = demoQuery.trim().toLowerCase();
    if (!q) return true;
    return [acc.display_name, acc.username, acc.role_label, acc.position || '', acc.hotel_name || '', acc.region_name || '']
      .some((v) => v.toLowerCase().includes(q));
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(username, password);
      showToast('登录成功，欢迎使用悦栖运营系统');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '登录失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickDemo = async (uname: string) => {
    setSubmitting(true);
    try {
      await switchDemoAccount(uname);
      showToast('已切换演示账号登录');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '切换失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F7F4] flex flex-col lg:flex-row">
      {/* Left Brand Panel */}
      <div className="lg:w-[46%] bg-[#1C1917] text-stone-100 p-8 lg:p-14 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white shadow-lg">
              <Hotel className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-wide text-white">悦栖运营 · YueQi Ops</h1>
              <p className="text-xs text-stone-400">连锁酒店日常内部业务管理系统</p>
            </div>
          </div>

          <div className="mt-12 space-y-6">
            <h2 className="text-3xl lg:text-4xl font-bold leading-tight text-white">
              门店协同更高效，
              <br />
              <span className="text-brand-400">HR 与报销风控</span>一目了然
            </h2>
            <p className="text-stone-400 text-sm leading-relaxed max-w-md">
              专为多门店连锁酒店打造：覆盖总部与区域/门店分级组织、员工全生命周期与健康证到期预警、跨店轮班排班、考勤联动薪资核算，以及多级动态报销审批、预算风控、发票查重与备用金冲销闭环。
            </p>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-2 gap-4 text-xs">
          <div className="p-4 rounded-2xl bg-stone-800/70 border border-stone-700/70">
            <ShieldCheck className="w-5 h-5 text-brand-400 mb-2" />
            <div className="font-semibold text-white">多级动态报销风控</div>
            <div className="text-stone-400 mt-1">按金额与预算自动路由，实时校验重复发票与超标预算</div>
          </div>
          <div className="p-4 rounded-2xl bg-stone-800/70 border border-stone-700/70">
            <UserCheck className="w-5 h-5 text-brand-400 mb-2" />
            <div className="font-semibold text-white">酒店业专属 HR 引擎</div>
            <div className="text-stone-400 mt-1">健康证预警、早中晚夜班跨店支援、夜班津贴自动算薪</div>
          </div>
        </div>
      </div>

      {/* Right Login & Demo Switcher */}
      <div className="flex-1 flex items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-xl space-y-6">
          <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-7">
            <div className="flex items-center gap-2 text-stone-900 font-semibold text-lg mb-1">
              <KeyRound className="w-5 h-5 text-brand-600" />
              <span>员工账号登录</span>
            </div>
            <p className="text-xs text-stone-500 mb-5">
              演示环境所有账号默认密码：<code className="px-1.5 py-0.5 bg-stone-100 rounded text-stone-800 font-mono">Hotel@2026</code>
            </p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">用户名</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
                  placeholder="请输入用户名，如 mgr_sh"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1.5">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
                  placeholder="请输入密码"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-sm font-semibold transition-colors disabled:opacity-50"
              >
                {submitting ? '登录中...' : '登录系统'}
              </button>
            </form>
          </div>

          {demoSwitchEnabled && demoAccounts.length > 0 && (
            <div className="bg-white rounded-2xl border border-stone-200 shadow-sm p-6">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
                <div className="text-xs font-semibold text-stone-700 uppercase tracking-wider">
                  快速体验 · 一键登录不同门店与审批角色 ({demoAccounts.length})
                </div>
                <input
                  type="text"
                  value={demoQuery}
                  onChange={(e) => setDemoQuery(e.target.value)}
                  placeholder="按姓名 / 门店 / 角色筛选"
                  className="px-2.5 py-1 rounded-lg border border-stone-200 text-xs w-full sm:w-44 focus:outline-none focus:border-brand-500"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[340px] overflow-y-auto pr-1">
                {filteredDemoAccounts.map((acc) => (
                  <button
                    key={acc.username}
                    type="button"
                    disabled={submitting}
                    onClick={() => handleQuickDemo(acc.username)}
                    className="text-left p-3 rounded-xl border border-stone-200 hover:border-brand-400 hover:bg-brand-50/50 transition-all"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-sm text-stone-900 truncate">
                        {acc.display_name}
                        {acc.position && (
                          <span className="text-xs font-normal text-stone-500 ml-1">· {acc.position}</span>
                        )}
                      </span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-brand-50 text-brand-700 border border-brand-200/70 shrink-0">
                        {acc.role_label}
                      </span>
                    </div>
                    <div className="text-xs text-stone-500 mt-1">
                      {acc.hotel_name || acc.region_name || '集团总部'} · @{acc.username}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
