import { categoryKey } from './revenue.js';
import type { ClassifiedSalesLine } from './revenue.js';
import type { TargetEntity } from './types.js';

export type BusinessValueKind = 'sale' | 'discount' | 'special' | 'unclassified';
export type PreparedSalesLine = ClassifiedSalesLine & {
  businessValueKind: BusinessValueKind;
};

// The Discount category also contains advances, services and consumables.
// Identify commercial discounts by product code rather than category or sign.
export const agritehnicaDiscountCodes = new Set(['~111', 'PT CLIENTI 709', 'DCH']);

export function salesValueKind(line: Record<string, unknown>, entity: TargetEntity): BusinessValueKind {
  // BORG 2.1 supplies the authoritative product type. An explicit null means
  // that its type export was unavailable, so keep that uncertainty visible.
  if ('tipLinie' in line) {
    switch (line.tipLinie) {
      case 'produs': return 'sale';
      case 'discount': return 'discount';
      case 'special': return 'special';
      default: return 'unclassified';
    }
  }
  // Compatibility with the old plain-array endpoint during deployment.
  if (entity === 'agritehnica') {
    const code = typeof line.codProdus === 'string' ? line.codProdus.trim().toUpperCase() : '';
    if (agritehnicaDiscountCodes.has(code)) return 'discount';
    if (typeof line.grupa === 'string' && categoryKey(line.grupa) === 'discount') return 'unclassified';
  }
  return 'sale';
}

/** Adds analysis fields without changing the original quantities or money. */
export function prepareSales(lines: ClassifiedSalesLine[], entity: TargetEntity): PreparedSalesLine[] {
  return lines.map(line => ({
    ...line,
    businessValueKind: salesValueKind(line, entity),
  }));
}
