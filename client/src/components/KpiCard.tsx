import React from 'react';

interface KpiCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  accent?: 'amber' | 'emerald' | 'rose' | 'stone';
  onClick?: () => void;
}

export function KpiCard({
  title,
  value,
  subtitle,
  icon,
  accent = 'stone',
  onClick,
}: KpiCardProps) {
  const accentMap = {
    amber: 'bg-brand-50 text-brand-700 border-brand-200/70',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200/70',
    rose: 'bg-rose-50 text-rose-700 border-rose-200/70',
    stone: 'bg-stone-100 text-stone-700 border-stone-200',
  };

  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-2xl border border-stone-200/90 p-5 shadow-sm transition-all ${
        onClick ? 'cursor-pointer hover:border-brand-300 hover:shadow-md' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-stone-500 tracking-wide">{title}</span>
        <div className={`w-9 h-9 rounded-xl border flex items-center justify-center ${accentMap[accent]}`}>
          {icon}
        </div>
      </div>
      <div className="mt-3 text-2xl font-bold text-stone-900 tabular-nums">{value}</div>
      {subtitle && <div className="mt-1.5 text-xs text-stone-500">{subtitle}</div>}
    </div>
  );
}
