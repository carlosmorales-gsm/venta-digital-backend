type DashboardRow = {
  status: string;
  sellerName: string | null;
  origen: string | null;
  planKind: string | null;
  funepet: boolean | string | number | null;
  estatus: string | null;
  branchName: string | null;
  synced: boolean | string | number | null;
  quoteId: number | string | null;
  createdAt: Date | string;
  amount: string | null;
  precioPlan: string | null;
  anticipo: string | null;
  saldo: string | null;
};

function moneyOf(raw: unknown): number {
  const n = Number(String(raw ?? '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function flag(value: unknown): boolean {
  return value === true || value === 'true' || value === 't' || value === 1 || value === '1';
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function bump(
  map: Map<string, { count: number; amount: number }>,
  key: string,
  amount: number,
) {
  const current = map.get(key) ?? { count: 0, amount: 0 };
  current.count += 1;
  current.amount += amount;
  map.set(key, current);
}

function ranked(
  map: Map<string, { count: number; amount: number }>,
  limit: number,
) {
  const list = [...map.entries()]
    .map(([key, value]) => ({
      key,
      count: value.count,
      amount: roundMoney(value.amount),
    }))
    .sort(
      (a, b) => b.count - a.count || b.amount - a.amount || a.key.localeCompare(b.key, 'es'),
    );
  if (list.length <= limit) return list;
  const rest = list.slice(limit);
  return [
    ...list.slice(0, limit),
    {
      key: 'Otros',
      count: rest.reduce((sum, row) => sum + row.count, 0),
      amount: roundMoney(rest.reduce((sum, row) => sum + row.amount, 0)),
    },
  ];
}

function ordered(
  order: string[],
  map: Map<string, { count: number; amount: number }>,
) {
  return order.map((key) => ({
    key,
    count: map.get(key)?.count ?? 0,
    amount: roundMoney(map.get(key)?.amount ?? 0),
  }));
}

function eachDay(from: string, to: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return [];
  }
  const days: string[] = [];
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor.getTime() <= end.getTime() && days.length < 120) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function buildDashboard(
  rows: DashboardRow[],
  range: { dateFrom: string; dateTo: string; timeZone: string },
) {
  const dayOf = (value: Date | string) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: range.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  };

  const byStatus = new Map<string, { count: number; amount: number }>();
  const byTipo = new Map<string, { count: number; amount: number }>();
  const byPlan = new Map<string, { count: number; amount: number }>();
  const byDay = new Map<string, { count: number; amount: number }>();
  const bySeller = new Map<string, { count: number; amount: number }>();
  const byOrigin = new Map<string, { count: number; amount: number }>();
  const byBranch = new Map<string, { count: number; amount: number }>();
  let amount = 0;
  let anticipo = 0;
  let saldo = 0;
  let synced = 0;
  let quoted = 0;

  for (const row of rows) {
    const planAmount = moneyOf(row.precioPlan) || moneyOf(row.amount);
    amount += planAmount;
    anticipo += moneyOf(row.anticipo);
    saldo += moneyOf(row.saldo);
    if (flag(row.synced)) synced += 1;
    if (Number(row.quoteId) > 0) quoted += 1;

    const status = String(row.status || '').toUpperCase();
    bump(byStatus, status === 'SUBMITTED' ? 'COMPLETED' : status, planAmount);

    const estatus = String(row.estatus || '').trim().toUpperCase();
    const tipo = flag(row.funepet)
      ? 'FUNEPET'
      : estatus === 'REACTIVACION' || estatus === 'RECONOCIMIENTO'
        ? 'RECONOCIMIENTO'
        : estatus === 'MEJORA' || estatus === 'MINORIA'
          ? estatus
          : 'NUEVA';
    bump(byTipo, tipo, planAmount);

    const plan = String(row.planKind || '').toUpperCase() === 'PARQUE' ? 'PARQUE' : 'PLAN_FUTURO';
    bump(byPlan, plan, planAmount);

    const day = dayOf(row.createdAt);
    if (day) bump(byDay, day, planAmount);
    bump(bySeller, (row.sellerName || '').trim() || 'Sin vendedor', planAmount);
    bump(byOrigin, (row.origen || '').trim() || 'Sin origen', planAmount);
    bump(byBranch, (row.branchName || '').trim() || 'Sin sucursal', planAmount);
  }

  const days = eachDay(range.dateFrom, range.dateTo);
  const dayKeys = days.length ? days : [...byDay.keys()].sort();

  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    total: rows.length,
    amount: roundMoney(amount),
    anticipo: roundMoney(anticipo),
    saldo: roundMoney(saldo),
    synced,
    quoted,
    byStatus: ordered(
      [
        'PENDING_PAYMENT',
        'PENDING_SIGNATURE',
        'PENDING_VALIDATION',
        'PENDING_CORRECTION',
        'PENDING_CORRECTION_REVIEW',
        'COMPLETED',
        'REJECTED',
      ],
      byStatus,
    ),
    byTipo: ordered(
      ['NUEVA', 'FUNEPET', 'MEJORA', 'MINORIA', 'RECONOCIMIENTO'],
      byTipo,
    ),
    byPlan: ordered(['PLAN_FUTURO', 'PARQUE'], byPlan),
    byDay: dayKeys.map((key) => ({
      key,
      count: byDay.get(key)?.count ?? 0,
      amount: roundMoney(byDay.get(key)?.amount ?? 0),
    })),
    bySeller: ranked(bySeller, 8),
    byOrigin: ranked(byOrigin, 8),
    byBranch: ranked(byBranch, 6),
  };
}
