// Totals for an invoice. Amounts are in major units (dollars) as decimals.
export function lineTotal(line) {
  return line.qty * line.unitPrice * (1 - line.discountPct / 100);
}
export function invoiceTotal(lines, taxPct) {
  const sub = lines.reduce((s, l) => s + lineTotal(l), 0);
  const tax = sub * (taxPct / 100);
  return Math.round((sub + tax) * 100) / 100;
}
export function format(amount) {
  return '$' + amount.toFixed(2);
}
