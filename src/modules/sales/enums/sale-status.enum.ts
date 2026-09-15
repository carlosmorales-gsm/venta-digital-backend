export enum SaleStatus {
  /** Captura en edición (máx. 3, 24 h). */
  DRAFT = 'DRAFT',
  /** Captura lista; falta registrar pago. */
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  /** Pago registrado; falta firma del titular. */
  PENDING_SIGNATURE = 'PENDING_SIGNATURE',
  /** Firmada; falta cliente y/o cotización de Odoo. */
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  /** Firmada y con cliente + cotización Odoo. */
  COMPLETED = 'COMPLETED',
  /** Rechazada desde Odoo (sin cotización vinculada). */
  REJECTED = 'REJECTED',
}
