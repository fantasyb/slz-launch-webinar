/**
 * A standalone appender for the multi-process audit test: append N entries to
 * the audit dir given on argv, as fast as it can. Run as several processes at
 * once against ONE dir, it exercises the cross-process lock — the chain must
 * come out intact even though the processes race. Not a *.test.ts file, so the
 * runner does not pick it up.
 *
 *   tsx test/helpers/audit-appender.ts <dir> <count> <label>
 */
import { appendAudit } from '../../src/lib/cairn/enterprise';

const [dir, countRaw, label] = process.argv.slice(2);
const count = Number(countRaw) || 0;
for (let i = 0; i < count; i++) {
  appendAudit(dir, { principal: label ?? 'p', decision: 'call', server: 's', tool: `t${i}`, session: label });
}
