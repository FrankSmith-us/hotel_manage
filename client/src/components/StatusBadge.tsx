import { STATUS_META } from '../lib/format';

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] || {
    label: status,
    cls: 'bg-stone-100 text-stone-700 border-stone-200',
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}
