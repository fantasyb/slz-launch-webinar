import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function relativeDays(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  // The unit is pluralised from the rounded number, not assumed plural: 30 to
  // 44 days rounds to one month and rendered "1 months ago" on every card that
  // showed a finding checked a month back. Years were worse — a fixed decimal
  // place printed "1.0 years ago", which reads as a measurement precise to the
  // month from a number that is nothing of the kind.
  if (days < 365) {
    const months = Math.round(days / 30);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }
  const years = Math.round(days / 365);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/**
 * Environment counts that may be fractional.
 *
 * `effectiveEnvironments` weighs an unsigned environment at half, so it returns
 * things like 0.5 and 1.5. Printing that raw gave "0.5 env" beside integer
 * counts elsewhere on the page; printing it as an integer would hide the very
 * halving the number exists to express. One decimal place, only when there is
 * one to show.
 */
export function formatEnvironments(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
