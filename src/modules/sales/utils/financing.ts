/**
 * Misma cuota que `computeFinancingBreakdown` del front.
 * Anticipo, frecuencia y plazo recalculan saldo, importe y días.
 */

type FrequencyCode = 'MENSUAL' | 'QUINCENAL' | 'SEMANAL' | 'CONTADO' | '';

type FrequencySpec = {
  factor: number;
  operator: 'multiplication';
  singlePayment?: boolean;
};

const FREQUENCY_SPECS: Record<Exclude<FrequencyCode, ''>, FrequencySpec> = {
  MENSUAL: { factor: 1, operator: 'multiplication' },
  QUINCENAL: { factor: 2, operator: 'multiplication' },
  SEMANAL: { factor: 4, operator: 'multiplication' },
  CONTADO: { factor: 1, operator: 'multiplication', singlePayment: true },
};

const FINANCE_DRIVERS = new Set([
  'pago.anticipo',
  'pago.frecuencia',
  'pago.plazo',
]);

export function correctionTouchesFinance(keys: string[]): boolean {
  return keys.some((key) => FINANCE_DRIVERS.has(key));
}

function money(raw: unknown): number {
  const n = Number(
    String(raw ?? '')
      .replace(/,/g, '')
      .replace(/[^0-9.-]/g, ''),
  );
  return Number.isFinite(n) ? n : 0;
}

function normalizeFrequency(raw: unknown): FrequencyCode {
  const t = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (t === 'MENSUAL' || t === 'QUINCENAL' || t === 'SEMANAL' || t === 'CONTADO') {
    return t;
  }
  if (t.includes('CONTADO') || t.includes('UNA SOLA')) return 'CONTADO';
  return '';
}

function defaultSpecificDays(frecuencia: FrequencyCode): string {
  if (frecuencia === 'QUINCENAL') return '5,20';
  if (frecuencia === 'SEMANAL') return '7,14,21,28';
  return '';
}

function cashPrice(precioPlan: unknown, descuentoPct: unknown): number {
  const precio = money(precioPlan);
  const pct = Math.min(100, Math.max(0, Math.trunc(money(descuentoPct))));
  return Math.max(0, Number((precio - (precio * pct) / 100).toFixed(2)));
}

function ceilPeso(amount: number): number {
  return Math.ceil(Math.round(amount * 10000) / 10000);
}

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return String(Number(amount.toFixed(2)));
}

export type CorrectionFinanceResult = {
  saldo: string;
  importeCadaPago: string;
  diasEspecificosPago: string;
  plazo: string;
  pagoInicial: string | null;
};

export function recomputeCorrectionFinance(input: {
  precioPlan: unknown;
  descuentoPct: unknown;
  anticipo: unknown;
  frecuencia: unknown;
  plazo: unknown;
  withoutInterest: boolean;
  recognizedBalance?: unknown;
  previousPagoInicial: unknown;
  previousDias: unknown;
  frequencyChanged: boolean;
}): CorrectionFinanceResult {
  const frequencyCode = normalizeFrequency(input.frecuencia);
  const plazoMeses =
    frequencyCode === 'CONTADO'
      ? 0
      : Math.max(0, Math.trunc(money(input.plazo)));
  const hitch = money(input.anticipo);
  const recognized = Math.max(0, money(input.recognizedBalance));
  const cash = cashPrice(input.precioPlan, input.descuentoPct);
  const saldo = Math.max(0, cash - hitch - recognized);
  const spec = frequencyCode ? FREQUENCY_SPECS[frequencyCode] : undefined;
  const denom = spec?.singlePayment ? 1 : plazoMeses * (spec?.factor || 0);

  let importe = 0;
  if (frequencyCode && cash) {
    if (frequencyCode === 'CONTADO') {
      importe = Math.max(0, cash - recognized);
    } else if (denom && plazoMeses) {
      if (input.withoutInterest) {
        importe = ceilPeso(Math.max(0, cash - hitch - recognized) / denom);
      } else {
        const vatFactor = 1.16;
        const commissionRate = 1;
        const priceWithoutCommission = cash / vatFactor / commissionRate;
        const hitchWithoutCommission = hitch / vatFactor / commissionRate;
        const priceWithoutHitch = priceWithoutCommission - hitchWithoutCommission;
        const financingCost =
          priceWithoutHitch * ((0.24 * 100) / 12 * plazoMeses) / 100;
        let preview = (priceWithoutHitch + financingCost) * vatFactor;
        if (recognized > 0) preview -= recognized;
        preview = Math.max(0, Number(preview.toFixed(2)));
        importe = ceilPeso(preview / denom);
      }
    }
  }

  const pagoInicialActivo = money(input.previousPagoInicial) > 0;
  return {
    saldo: String(Number(saldo.toFixed(2))),
    importeCadaPago: formatAmount(importe),
    diasEspecificosPago: input.frequencyChanged
      ? defaultSpecificDays(frequencyCode)
      : String(input.previousDias ?? '').trim(),
    plazo: frequencyCode === 'CONTADO' ? '0' : String(input.plazo ?? '').trim(),
    pagoInicial: pagoInicialActivo ? formatAmount(importe) : null,
  };
}

export function sameMoney(left: unknown, right: unknown): boolean {
  return money(left).toFixed(2) === money(right).toFixed(2);
}

export function formatCorrectionMoney(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (!text) return '—';
  return money(raw).toLocaleString('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
