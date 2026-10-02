import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import type { SalesReconciliation } from './salesReconciliation.js';
import { readSalesReconciliations } from './salesReconciliation.js';

/** RFC 4180 quoting, including commas, escaped quotes and embedded newlines. */
export function parseCsv(input: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  const text = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted || field === '') quoted = !quoted;
      else throw new Error('Invalid CSV quoting.');
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      record.push(field); field = '';
      if (char !== ',') {
        if (record.some(value => value !== '')) records.push(record);
        record = [];
        if (char === '\r' && text[i + 1] === '\n') i++;
      }
    } else field += char;
  }
  if (quoted) throw new Error('Unterminated CSV quote.');
  if (field || record.length) { record.push(field); records.push(record); }
  const headers = records.shift();
  if (!headers || new Set(headers).size !== headers.length) throw new Error('Missing or duplicate CSV headers.');
  return records.map(row => {
    if (row.length !== headers.length) throw new Error('CSV row has the wrong number of fields.');
    return Object.fromEntries(headers.map((header, i) => [header, row[i]!]));
  });
}

function numeric(value: string | undefined): number {
  if (value === undefined || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$/.test(value.trim())) {
    throw new Error('Expected a CSV number with a decimal point and optional thousands commas.');
  }
  const number = Number(value.replaceAll(',', '').replace('%', ''));
  if (!Number.isFinite(number)) throw new Error('Invalid CSV number.');
  return number;
}

function date(value: string | undefined): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? '');
  if (!match) throw new Error('Expected report dates in DD/MM/YYYY format.');
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) throw new Error('Invalid report date.');
  return iso;
}

const money = (value: number) => Math.round(value * 100) / 100;
export function buildReconciliation(salesCsv: string, discountCsv: string, options: {
  month: string; salesMarker: number; discountMarker: number; label?: string;
}): SalesReconciliation {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month)) throw new Error('Expected a YYYY-MM month.');
  const prefix = `report:agritehnica:piese:${options.month}`;
  const revision = createHash('sha256').update(JSON.stringify([salesCsv, discountCsv, options])).digest('hex');
  const lines: Record<string, unknown>[] = [];
  for (const [kind, input] of [['sale', salesCsv], ['discount', discountCsv]] as const) {
    const rows = parseCsv(input);
    const required = kind === 'sale'
      ? ['Client', 'Serie', 'Data', 'Numar', 'Tip', 'Denumire grupa', 'Denumire', 'UM', 'Cantitate', 'TVA %', 'Cost', 'Pret vanzare fara TVA', 'Valoare vanzare', 'Adaos']
      : ['DenumireGestiune', 'Grupa', 'Denumire', 'Cod', 'UM', 'Cantitate', 'Pret', 'Valoare', 'TVA %', 'Client', 'NumarDoc', 'SerieDoc', 'Data', 'Tip', 'Gestiune'];
    if (!rows.length || !required.every(header => header in rows[0]!)) throw new Error(`Missing ${kind} report columns.`);
    for (const [index, row] of rows.entries()) {
      const issued = date(row.Data);
      if (!issued.startsWith(`${options.month}-`)) continue;
      if (!['AIM', 'AIMS', 'BFD'].includes(row.Tip!)) throw new Error('Unsupported business report document type.');
      const series = row[kind === 'sale' ? 'Serie' : 'SerieDoc']!;
      const number = row[kind === 'sale' ? 'Numar' : 'NumarDoc']!;
      const net = numeric(row[kind === 'sale' ? 'Valoare vanzare' : 'Valoare']);
      const vatRate = numeric(row['TVA %']);
      const vat = money(net * vatRate / 100);
      const cost = kind === 'sale' ? numeric(row.Cost) : 0;
      lines.push({
        miscareId: `${prefix}:${kind}:${index}`, documentId: `${prefix}:${row.Tip}:${series}:${number}`,
        tipDocument: row.Tip, canal: row.Tip === 'BFD' ? 'retail' : 'aviz', serie: series, numar: number, data: issued,
        client: row.Client, produs: row.Denumire, codProdus: kind === 'discount' ? row.Cod : null,
        grupa: row[kind === 'sale' ? 'Denumire grupa' : 'Grupa'], um: row.UM,
        gestiuneId: kind === 'discount' ? numeric(row.Gestiune) : null,
        depozit: kind === 'discount' ? row.DenumireGestiune : null,
        cantitate: numeric(row.Cantitate), pretUnitarNet: numeric(row[kind === 'sale' ? 'Pret vanzare fara TVA' : 'Pret']),
        cotaTVA: vatRate, valoareNet: net, valoareTVA: vat, valoareTotal: money(net + vat), costTotal: cost,
        marja: kind === 'sale' ? numeric(row.Adaos) : net, businessValueKind: kind,
      });
    }
  }
  const total = (kind: string) => money(lines.filter(line => line.businessValueKind === kind)
    .reduce((sum, line) => sum + Math.round(Number(line.valoareNet) * 100), 0) / 100);
  const csvSalesBeforeDiscounts = total('sale');
  const csvDiscounts = -total('discount');
  if (!lines.some(line => line.businessValueKind === 'sale')) throw new Error('No sales in the selected report month.');
  for (const [kind, value] of [['sale', money(options.salesMarker - csvSalesBeforeDiscounts)],
    ['discount', money(csvDiscounts - options.discountMarker)]] as const) {
    if (Math.abs(value) > 1) throw new Error('Business marker differs from the CSV by more than one leu; investigate the source.');
    if (!value) continue;
    const lastDay = new Date(`${options.month}-01T00:00:00Z`);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
    lines.push({ miscareId: `${prefix}:${kind}:rounding`, documentId: null, data: lastDay.toISOString().slice(0, 10),
      tipDocument: 'AIM', produs: `Ajustare reconciliere business (${kind === 'sale' ? 'vânzări' : 'discounturi'})`,
      grupa: 'Reconciliere business', cantitate: 0, valoareNet: value, valoareTVA: 0, valoareTotal: value,
      costTotal: 0, marja: value, businessValueKind: kind, businessReconciliationAdjustment: true });
  }
  return { targetEntity: 'agritehnica', groupId: 'piese', month: options.month,
    label: options.label ?? 'Raport business Piese', revision, salesBeforeDiscounts: options.salesMarker,
    discounts: options.discountMarker, csvSalesBeforeDiscounts, csvDiscounts, lines };
}

async function main() {
  const { values } = parseArgs({ options: {
    sales: { type: 'string' }, discounts: { type: 'string' }, month: { type: 'string' },
    'sales-marker': { type: 'string' }, 'discount-marker': { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.sales || !values.discounts || !values.month || !values.output || !values['sales-marker'] || !values['discount-marker']) {
    throw new Error('Usage: npm run sales:reconcile -- --sales FILE --discounts FILE --month YYYY-MM --sales-marker AMOUNT --discount-marker AMOUNT --output PRIVATE_FILE');
  }
  const report = buildReconciliation(await readFile(values.sales, 'utf8'), await readFile(values.discounts, 'utf8'), {
    month: values.month, salesMarker: numeric(values['sales-marker']), discountMarker: numeric(values['discount-marker']),
    label: `${basename(values.sales)} + ${basename(values.discounts)}`,
  });
  await writeFile(values.output, JSON.stringify([report]), { mode: 0o600, flag: 'wx' });
  await readSalesReconciliations(values.output);
  console.log(JSON.stringify({ month: report.month, lines: report.lines.length,
    salesBeforeDiscounts: report.salesBeforeDiscounts, discounts: report.discounts,
    net: money(report.salesBeforeDiscounts - report.discounts),
    csvSalesBeforeDiscounts: report.csvSalesBeforeDiscounts, csvDiscounts: report.csvDiscounts }, null, 2));
}

if (process.argv[1]?.endsWith('importSalesReconciliation.ts') || process.argv[1]?.endsWith('importSalesReconciliation.js')) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Import failed.'); process.exitCode = 1; });
}
