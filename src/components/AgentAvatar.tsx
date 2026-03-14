'use client';

export function AgentAvatar({ name, color, size = 'md' }: { name: string; color: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-10 h-10 text-sm',
    lg: 'w-16 h-16 text-xl',
  };

  const initials = name
    .split(/(?=[A-Z])/)
    .slice(0, 2)
    .map(s => s[0])
    .join('');

  return (
    <div
      className={`${sizes[size]} rounded-lg flex items-center justify-center font-bold text-white flex-shrink-0`}
      style={{ backgroundColor: color }}
    >
      {initials}
    </div>
  );
}
