export enum SaleStatus {
  /** Captura en edición (máx. 3, 24 h). */
  DRAFT = 'DRAFT',
  /** Captura lista; falta registrar pago. */
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  /** Pago registrado; falta firma del titular. */
  PENDING_SIGNATURE = 'PENDING_SIGNATURE',
  /** Firmada; falta cliente y/o cotización de Odoo. */
  PENDING_VALIDATION = 'PENDING_VALIDATION',
  /** Mesa de Control pidió corregir datos o documentos. */
  PENDING_CORRECTION = 'PENDING_CORRECTION',
  /** El vendedor ya reenvió la corrección; Mesa debe aceptarla o rechazarla. */
  PENDING_CORRECTION_REVIEW = 'PENDING_CORRECTION_REVIEW',
  /** Firmada y con cliente + cotización Odoo. */
  COMPLETED = 'COMPLETED',
  /** Rechazada desde Odoo (sin cotización vinculada). */
  REJECTED = 'REJECTED',
}
