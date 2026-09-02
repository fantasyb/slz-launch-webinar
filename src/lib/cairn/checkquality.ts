import type { Finding } from './schema';

/**
 * Whether a check actually decides anything.
 *
 * `doctor` reports a finding as LIVE ON THIS MACHINE when its check exits
 * zero. That is only information if the check exits non-zero when the trap is
 * absent, and across the first forty findings it usually did not: eight ended
 * in `; echo "exit=$?"` or `console.log` on both branches, so they exited zero
 * wherever the shell ran and "live" meant "a shell exists". The verdict lived
 * in `confirmedIf` prose for a human to compare against stdout -- which is the
 * job the executable check exists to remove.
 *
 * This is the cheap half of the gate: pure text, no execution, catches the
 * whole "the shell ran" class. The expensive half is running the check twice
 * under a delta; see `deltaPlan`.
 */

export interface CheckFlaw {
  rule: string;
  detail: string;
}

/*
 * Patterns that discard the exit status of the thing being tested.
 *
 * Each was taken from a real check in this corpus rather than imagined, and
 * each fails the same way: the interesting command's status is replaced by
 * the status of an echo, an awk, or the second half of an || pair.
 */
const DISCARDS: Array<{ re: RegExp; rule: string; detail: string }> = [
  {
    re: /;\s*echo\b/,
    rule: 'exit-status-discarded',
    detail: 'ends in `; echo ...`, so the check exits 0 whatever the command before it did',
  },
  {
    re: /\|\|\s*echo\b/,
    rule: 'exit-status-discarded',
    detail: '`|| echo` swallows the failure it is supposed to report',
  },
  {
    re: /&&\s*echo\b[\s\S]*\|\|\s*/,
    rule: 'exit-status-discarded',
    detail: '`&& echo ... || echo ...` reports both branches as success',
  },
  {
    re: /\|\s*(awk|tail|head|cut|sed)\b(?![\s\S]*\bexit\b)/,
    rule: 'verdict-in-stdout',
    detail:
      'pipes into a formatter and never exits non-zero, so the verdict is prose for a human ' +
      'to compare rather than something doctor can decide',
  },
  {
    re: /console\.log\([\s\S]*\)[\s\S]*console\.log\(/,
    rule: 'verdict-in-stdout',
    detail: 'prints on both branches instead of exiting differently',
  },
];

/** Commands a check may rely on without declaring them. */
const ASSUMED = new Set(['sh', 'test', 'true', 'false', 'exit', 'command', 'echo']);

/**
 * A check that cannot tell "absent" from "cannot run".
 *
 * `grep` exits 2 on a missing file, which reads as a clean does-not-reproduce
 * on a machine that simply does not have the thing. Exit 77 is this project's
 * "could not decide"; a check depending on a binary it never guards for
 * reports a false negative under a confident label.
 */
function undeclaredDependency(command: string): CheckFlaw | null {
  if (/\bcommand -v\b|\bwhich\b|\bexit 77\b/.test(command)) return null;
  const first = command.trim().split(/[\s|;&]+/)[0]?.replace(/^\W+/, '');
  if (!first || ASSUMED.has(first) || /^[A-Z]/.test(first)) return null;
  if (!/^(rg|jq|dig|nslookup|host|getent|pnpm|npx|tsx|playwright|curl|python3?)$/.test(first)) {
    return null;
  }
  return {
    rule: 'undeclared-dependency',
    detail:
      `depends on \`${first}\` without a \`command -v ${first} || exit 77\` guard, so a machine ` +
      'that lacks it reports "does not reproduce" rather than "could not decide"',
  };
}

/**
 * Static flaws in a check. Empty means it may be worth running; it does not
 * mean the check is good, only that it is not broken in a way text can see.
 */
export function checkFlaws(check: Finding['check']): CheckFlaw[] {
  if (check.manual) return [];
  const cmd = check.command.trim();
  const flaws: CheckFlaw[] = [];

  /*
   * A command that exits non-zero somewhere has a failure path, so printing
   * along the way is reporting rather than the verdict. cairn-0005 prints
   * three lines and ends in `process.exit(leaked.length>0?0:1)`, which is the
   * contract honoured exactly; a rule that reads "prints twice" as "decides
   * nothing" fails the one check in the corpus that gets this right.
   *
   * Exit 77 is excluded: that is this project's "could not decide", and a
   * command whose only non-zero exit is 77 still never reports a verdict.
   */
  /*
   * A trailing test expression is a verdict too. `[ "$MS" -gt 40 ]` as the
   * last statement IS the decision — the shell's exit status is the
   * comparison — and the rules below were reading the diagnostic `echo`
   * before it as though the status had been thrown away. Refusing that check
   * is a false positive, and a gate that refuses correct work teaches people
   * to pass --force.
   */
  const lastLine = cmd.split('\n').filter((l) => l.trim()).pop() ?? '';
  const endsInTest = /(^|;|&&|\|\|)\s*(\[\[?\s|test\s)/.test(lastLine);
  const decides =
    endsInTest ||
    /process\.exit\(\s*[^0)\s]/.test(cmd) ||
    /\bexit\s+(?!0\b|77\b)[1-9]/.test(cmd);
  const seen = new Set<string>();
  for (const d of DISCARDS) {
    if (decides && (d.rule === 'verdict-in-stdout' || d.rule === 'exit-status-discarded')) continue;
    if (d.re.test(cmd) && !seen.has(d.detail)) {
      seen.add(d.detail);
      flaws.push({ rule: d.rule, detail: d.detail });
    }
  }
  /*
   * An interpreter invoked with a program that never exits deliberately.
   *
   * `node -e "...console.log(ok?'NS_OK':'NS_FAIL')"` computes the verdict and
   * then throws it away: the process exits 0 either way, so doctor reports it
   * live on every machine where node runs. The ternary makes it look like a
   * decision; only the exit status is one. Caught separately because a single
   * console.log does not match the two-branch pattern above.
   */
  if (!decides && /\b(node\s+-e|python3?\s+-c|deno\s+eval)\b/.test(cmd) && !seen.has('interp')) {
    seen.add('interp');
    flaws.push({
      rule: 'verdict-in-stdout',
      detail:
        'runs an interpreter that never exits non-zero, so the verdict it computes is printed ' +
        'and discarded — doctor reports it live wherever the interpreter exists',
    });
  }

  const dep = undeclaredDependency(cmd);
  if (dep) flaws.push(dep);
  return flaws;
}
