import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        raised: 'var(--paper-raised)',
        ink: {
          DEFAULT: 'var(--ink)',
          soft: 'var(--ink-soft)',
          faint: 'var(--ink-faint)',
        },
        rule: {
          DEFAULT: 'var(--rule)',
          strong: 'var(--rule-strong)',
        },
        moss: { DEFAULT: 'var(--moss)', soft: 'var(--moss-soft)' },
        ochre: { DEFAULT: 'var(--ochre)', soft: 'var(--ochre-soft)' },
        rust: { DEFAULT: 'var(--rust)', soft: 'var(--rust-soft)' },
        slate: { DEFAULT: 'var(--slate)', soft: 'var(--slate-soft)' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: { stone: 'var(--shadow)' },
      maxWidth: { reading: '68ch' },
    },
  },
  plugins: [],
} satisfies Config;
