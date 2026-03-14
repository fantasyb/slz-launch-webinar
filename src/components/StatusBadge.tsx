'use client';

export function StatusBadge({ status }: { status: 'online' | 'offline' | 'busy' }) {
  const styles = {
    online: 'bg-emerald-500/20 text-emerald-400',
    offline: 'bg-zinc-700/50 text-zinc-500',
    busy: 'bg-amber-500/20 text-amber-400',
  };

  const dotStyles = {
    online: 'bg-emerald-400 status-online',
    offline: 'bg-zinc-600',
    busy: 'bg-amber-400',
  };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotStyles[status]}`} />
      {status}
    </span>
  );
}
