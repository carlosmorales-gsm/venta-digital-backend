import { Sale } from '../entities/sale.entity';
import { SaleHolder } from '../entities/sale-holder.entity';
import { SaleSecondContact } from '../entities/sale-second-contact.entity';
import { SaleSubstituteHolder } from '../entities/sale-substitute-holder.entity';
import { SaleBeneficiary } from '../entities/sale-beneficiary.entity';
import { SaleDocument } from '../entities/sale-document.entity';
import { DocumentKind } from '../enums/document-kind.enum';
import { PlanKind } from '../enums/plan-kind.enum';
import { SaleFormPayloadDto } from '../dto/sale-form.dto';
import { normalizeMxPhone } from '../utils/phone';
import { formatDigitalFolio } from '../utils/digital-folio';

function s(v: unknown, fallback = ''): string {
  return v == null ? fallback : String(v).trim();
}

function isNominaTipo(raw?: string | null): boolean {
  const t = s(raw).toUpperCase();
  return t === 'NOMINA' || t === 'NÓMINA';
}

export function isUasConvenioPago(pago?: {
  empresaNominaId?: number | null;
  empresaNomina?: string | null;
} | null): boolean {
  const id = Number(pago?.empresaNominaId);
  if (Number.isFinite(id) && id === 1) return true;
  return s(pago?.empresaNomina).toUpperCase() === 'UAS';
}

export function needsCardDocumentos(
  tipoCobranza?: string | null,
  pago?: {
    empresaNominaId?: number | null;
    empresaNomina?: string | null;
  } | null,
): boolean {
  const tipo = s(tipoCobranza).toUpperCase();
  if (tipo === 'DOMICILIADO') return true;
  return isNominaTipo(tipo) && isUasConvenioPago(pago);
}

function tipoVentaFromEstatus(estatus: string): string {
  const key = String(estatus ?? '')
    .trim()
    .toUpperCase();
  if (key === 'REACTIVACION') return 'RECONOCIMIENTO';
  if (key === 'MEJORA') return 'MEJORA';
  if (key === 'MINORIA') return 'MINORIA';
  return 'NUEVA';
}

function parseReconocimientoVentas(raw: string | null | undefined) {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stringifyReconocimientoVentas(value: unknown): string {
  if (!Array.isArray(value) || !value.length) return '';
  return JSON.stringify(value);
}

function estatusFromTipoVenta(tipo?: string): string | null {
  const t = String(tipo ?? '')
    .trim()
    .toUpperCase();
  if (t === 'NUEVA') return 'ACTIVO';
  if (t === 'RECONOCIMIENTO') return 'REACTIVACION';
  if (t === 'MEJORA') return 'MEJORA';
  if (t === 'MINORIA') return 'MINORIA';
  return null;
}

/** Solo el folio de cotización Odoo. Los mocks de captura no cuentan. */
export function realContrato(v: unknown): string {
  const t = s(v);
  if (!t || /^VD-(MOCK|DEMO)-/i.test(t)) return '';
  return t;
}

function money(v: unknown): number {
  const n = Number(String(v ?? '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function recognizedFromVentas(raw: string | null | undefined): number {
  const list = parseReconocimientoVentas(raw);
  return list.reduce((sum, item: any) => {
    const total = money(item?.amountTotal);
    const remaining = money(item?.saldo);
    return sum + Math.max(0, total - remaining);
  }, 0);
}

/** Saldo = precio − descuento − anticipo − saldo reconocido (≥ 0). */
export function computeSaldo(
  precioPlan: unknown,
  descuentoPct: unknown,
  anticipo: unknown,
  recognizedBalance: unknown = 0,
): string {
  const precio = money(precioPlan);
  const pct = Math.min(100, Math.max(0, money(descuentoPct)));
  const descuentoMonto = (precio * pct) / 100;
  const saldo = Math.max(
    0,
    precio - descuentoMonto - money(anticipo) - money(recognizedBalance),
  );
  return String(Number(saldo.toFixed(2)));
}

function dateOrNull(v: unknown): string | null {
  const t = s(v);
  if (!t) return null;
  return t.slice(0, 10);
}

export function fullName(p: {
  apellidoPaterno?: string;
  apellidoMaterno?: string;
  nombres?: string;
}): string {
  return [p.apellidoPaterno, p.apellidoMaterno, p.nombres]
    .map((x) => s(x))
    .filter(Boolean)
    .join(' ');
}

function optionalInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** API pública: entidad tipada + payload ensamblado para el front/PDF. */
export function saleToPublic(sale: Sale) {
  const reconocimientoVentas = parseReconocimientoVentas(
    sale.reconocimientoVentas,
  );
  return {
    id: sale.id,
    sellerId: sale.sellerId,
    sellerName: sale.sellerName,
    status: sale.status,
    amount: Number(sale.amount) || 0,
    titularName: sale.titularName,
    odooPartnerId: sale.odooPartnerId ?? null,
    odooSaleOrderId: sale.odooSaleOrderId ?? null,
    odooReceptionSynced: sale.odooReceptionSynced,
    draftExpiresAt: toIso(sale.draftExpiresAt),
    createdAt: toIso(sale.createdAt) ?? '',
    updatedAt: toIso(sale.updatedAt) ?? '',
    driveFolderUrl: sale.driveFolderUrl,
    driveFolderPath: sale.driveFolderPath,
    tipoVenta: tipoVentaFromEstatus(sale.estatus),
    recognizedBalance: recognizedFromVentas(sale.reconocimientoVentas),
    recognitionOriginIds: reconocimientoVentas
      .map((item: { id?: number }) => Number(item?.id) || 0)
      .filter((id: number) => id > 0),
    payload: saleToPayload(sale),
  };
}

/** Listado del vendedor/monitor: sin adjuntos ni payload completo. */
export function saleToListItem(sale: Sale) {
  return {
    id: sale.id,
    sellerId: sale.sellerId,
    sellerName: sale.sellerName,
    status: sale.status,
    amount: Number(sale.amount) || 0,
    titularName: sale.titularName,
    contrato: realContrato(sale.contrato),
    odooPartnerId: sale.odooPartnerId ?? null,
    odooSaleOrderId: sale.odooSaleOrderId ?? null,
    odooReceptionSynced: sale.odooReceptionSynced,
    draftExpiresAt: toIso(sale.draftExpiresAt),
    createdAt: toIso(sale.createdAt) ?? '',
    updatedAt: toIso(sale.updatedAt) ?? '',
    driveFolderUrl: sale.driveFolderUrl,
    driveFolderPath: sale.driveFolderPath,
    precioPlan: sale.precioPlan ?? '',
    promocionDescuento: sale.promocionDescuento ?? '',
    anticipo: sale.anticipo ?? '',
    saldo: sale.saldo ?? '',
    payload: {},
  };
}

export function saleToPayload(sale: Sale): Record<string, unknown> {
  const h = sale.holder;
  const sc = sale.secondContact;
  const ts = sale.substituteHolder;
  const bens = [...(sale.beneficiaries ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const docs = sale.documents ?? [];
  const findDoc = (kind: DocumentKind) => {
    const d = docs.find((x) => x.kind === kind);
    if (!d) return null;
    return {
      name: d.name,
      mime: d.mime,
      dataBase64: d.driveFileUrl ? '' : (d.dataBase64 ?? ''),
      driveFileId: d.driveFileId ?? null,
      driveFileUrl: d.driveFileUrl ?? null,
    };
  };

  return {
    meta: {
      fecha: sale.fecha ?? '',
      contrato: realContrato(sale.contrato),
      origenVenta: sale.origenVenta,
      branchId: sale.branchId,
      branchName: sale.branchName,
      serviceTypeId: sale.serviceTypeId,
      serviceTypeName: sale.serviceTypeName,
      folioSolicitud: formatDigitalFolio(sale.folioSolicitud || sale.id),
      fechaServicio: sale.fechaServicio ?? '',
      tipoVenta: tipoVentaFromEstatus(sale.estatus),
      estatus: sale.estatus,
      anterior: sale.anterior,
      verificacion: sale.verificacion,
      reconocimientoVentas: parseReconocimientoVentas(sale.reconocimientoVentas),
    },
    contacto: h
      ? {
          apellidoPaterno: h.apellidoPaterno,
          apellidoMaterno: h.apellidoMaterno,
          nombres: h.nombres,
          sexo: h.sexo,
          curp: h.curp,
          factura: h.factura,
          tipoPersona: h.tipoPersona,
          razonSocial: h.razonSocial,
          rfc: h.rfc,
          facturaCp: h.facturaCp,
          regimenFiscal: h.regimenFiscal,
          regimenFiscalOtro: h.regimenFiscalOtro,
          telefonoFactura: h.telefonoFactura,
          direccion: h.direccion,
          colonia: h.colonia,
          cp: h.cp,
          entreCalles: h.entreCalles,
          senaParticular: h.senaParticular,
          municipio: h.municipio,
          estado: h.estado,
          tipoCobranza: h.tipoCobranza,
          fechaNacimiento: h.fechaNacimiento ?? '',
          sindicalizado: h.sindicalizado,
          observaciones: h.observaciones,
          celular1: h.celular1,
          celular2: h.celular2,
          correo: h.correo,
          estadoCivil: h.estadoCivil,
          domicilioEntregaDocumentacion: h.domicilioEntregaDocumentacion,
        }
      : {},
    segundoContacto: sc
      ? {
          apellidoPaterno: sc.apellidoPaterno,
          apellidoMaterno: sc.apellidoMaterno,
          nombres: sc.nombres,
          celular: sc.celular,
          parentesco: sc.parentesco,
          relationId: sc.relationId ?? null,
          direccion: sc.direccion,
          colonia: sc.colonia,
          cp: sc.cp,
          entreCalles: sc.entreCalles,
          fechaNacimiento: sc.fechaNacimiento ?? '',
          domicilioEntregaDocumentacion: sc.domicilioEntregaDocumentacion,
        }
      : {},
    beneficiarios: bens.map((b) => benToPayload(b)),
    derechohabientes: {
      titularSustituto: substituteToPayload(ts),
      primerBeneficiario: benToPayload(bens[0]),
      segundoBeneficiario: benToPayload(bens[1]),
    },
    ubicacionPlan: {
      planKind: sale.planKind,
      nombrePlan: sale.nombrePlan,
      productId: sale.productId,
      productDefaultCode: sale.productDefaultCode,
      precioPlan: sale.precioPlan,
      seccion: sale.seccion,
      cuadrante: sale.cuadrante,
      numero: sale.numero,
      servicioFunerario: sale.servicioFunerario,
      parqueFuneral: sale.parqueFuneral,
      parkId: sale.parkId,
      sectionId: sale.sectionId,
      quadrantId: sale.quadrantId,
      spaceId: sale.spaceId,
      preasignacion: sale.preasignacion,
      withoutInterest: sale.withoutInterest,
    },
    pago: {
      precioPlan: sale.precioPlan,
      frecuencia: sale.frecuencia,
      promocionDescuento: sale.promocionDescuento,
      anticipo: sale.anticipo,
      pagoInicial: sale.pagoInicial,
      plazo: sale.plazo,
      importeCadaPago: sale.importeCadaPago,
      saldo: sale.saldo,
      fechaProximoPago: sale.fechaProximoPago ?? '',
      diasEspecificosPago: sale.diasEspecificosPago,
      formaPago: sale.formaPago,
      cuenta: sale.cuenta,
      banco: sale.banco,
      cuentaPago: sale.cuentaPago,
      bancoPago: sale.bancoPago,
      vencimientoTarjeta: sale.vencimientoTarjeta,
      titularTarjeta: sale.titularTarjeta,
      cvv: sale.cvv,
      numeroEmpleado: sale.numeroEmpleado,
      nombreEmpleado: sale.nombreEmpleado,
      empresaNomina: sale.empresaNomina,
      empresaNominaId: sale.empresaNominaId,
      infoNomina: sale.infoNomina,
      montoRecibido: sale.montoRecibido,
      cambio: sale.cambio,
      nombreJefeVentas: sale.nombreJefeVentas,
      nombreAsesor: sale.nombreAsesor,
    },
    declaraciones: {
      aceptaMercadotecnia: sale.aceptaMercadotecnia,
      aceptaPublicidad: sale.aceptaPublicidad,
    },
    documentos: {
      ineFrente: findDoc(DocumentKind.INE_FRENTE),
      ineReverso: findDoc(DocumentKind.INE_REVERSO),
      inePdf: findDoc(DocumentKind.INE),
      comprobanteDomicilio: findDoc(DocumentKind.COMPROBANTE),
      constanciaSituacionFiscal: findDoc(DocumentKind.CONSTANCIA_FISCAL),
      tarjetaFrente: findDoc(DocumentKind.TARJETA_FRENTE),
      tarjetaReverso: findDoc(DocumentKind.TARJETA_REVERSO),
      tarjetaPdf: findDoc(DocumentKind.TARJETA),
      reciboNomina: findDoc(DocumentKind.RECIBO_NOMINA),
      domiciliacionBanorte: findDoc(DocumentKind.BANORTE_DOM),
      firmaCliente: findDoc(DocumentKind.FIRMA),
      ticketPago: findDoc(DocumentKind.TICKET_PAGO),
      comprobanteTransferencia: findDoc(DocumentKind.COMP_TRANSFERENCIA),
      caratulaPdf: findDoc(DocumentKind.CARATULA),
      cartaFacturaPdf: findDoc(DocumentKind.CARTA_FACTURA),
      cartaNoFacturaPdf: findDoc(DocumentKind.CARTA_NO_FACTURA),
      cartaExclusionesPdf: findDoc(DocumentKind.CARTA_EXCLUSIONES),
      reglamentoParquePdf: findDoc(DocumentKind.REGLAMENTO_PARQUE),
      reglamentoParqueFolletoPdf: findDoc(DocumentKind.REGLAMENTO_FOLLETO),
      cartaAutorizacionPdf: findDoc(DocumentKind.CARTA_AUTORIZACION),
      cartaNominaPdf: findDoc(DocumentKind.CARTA_NOMINA),
    },
  };
}

function emptyBen() {
  return {
    apellidoPaterno: '',
    apellidoMaterno: '',
    nombres: '',
    parentesco: '',
    relationId: null as number | null,
    celular: '',
    fechaNacimiento: '',
  };
}

function benToPayload(b: SaleBeneficiary | null | undefined) {
  if (!b) return emptyBen();
  return {
    apellidoPaterno: b.apellidoPaterno,
    apellidoMaterno: b.apellidoMaterno,
    nombres: b.nombres,
    parentesco: b.parentesco,
    relationId: b.relationId ?? null,
    celular: b.celular,
    fechaNacimiento: b.fechaNacimiento ?? '',
  };
}

function substituteToPayload(sh: SaleSubstituteHolder | null | undefined) {
  if (!sh) return emptyBen();
  return {
    apellidoPaterno: sh.apellidoPaterno,
    apellidoMaterno: sh.apellidoMaterno,
    nombres: sh.nombres,
    parentesco: sh.parentesco,
    relationId: sh.relationId ?? null,
    celular: sh.celular,
    fechaNacimiento: sh.fechaNacimiento ?? '',
  };
}

function applyBenPayload(
  row: SaleBeneficiary | SaleSubstituteHolder,
  b: {
    apellidoPaterno?: string;
    apellidoMaterno?: string;
    nombres?: string;
    parentesco?: string;
    relationId?: number | null;
    celular?: string;
    fechaNacimiento?: string;
  },
) {
  row.apellidoPaterno = s(b.apellidoPaterno);
  row.apellidoMaterno = s(b.apellidoMaterno);
  row.nombres = s(b.nombres);
  row.parentesco = s(b.parentesco);
  row.relationId =
    b.relationId != null && Number(b.relationId) > 0
      ? Number(b.relationId)
      : null;
  row.celular = normalizeMxPhone(b.celular);
  row.fechaNacimiento = dateOrNull(b.fechaNacimiento);
}

/**
 * Snapshot plano para bitácora (sin base64 ni datos sensibles de archivos).
 */
export function saleToAuditSnapshot(sale: Sale): Record<string, unknown> {
  const h = sale.holder;
  const sc = sale.secondContact;
  const bens = [...(sale.beneficiaries ?? [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const docs = sale.documents ?? [];
  const docLabels: string[] = [];
  if (docs.some((d) => d.kind === DocumentKind.INE)) {
    docLabels.push('INE (ambos lados)');
  } else {
    if (docs.some((d) => d.kind === DocumentKind.INE_FRENTE)) {
      docLabels.push('INE (frente)');
    }
    if (docs.some((d) => d.kind === DocumentKind.INE_REVERSO)) {
      docLabels.push('INE (reverso)');
    }
  }
  if (docs.some((d) => d.kind === DocumentKind.COMPROBANTE)) {
    docLabels.push('Comprobante de domicilio');
  }
  if (docs.some((d) => d.kind === DocumentKind.CONSTANCIA_FISCAL)) {
    docLabels.push('Constancia de situación fiscal');
  }
  if (docs.some((d) => d.kind === DocumentKind.TARJETA)) {
    docLabels.push('Tarjeta (ambos lados)');
  } else {
    if (docs.some((d) => d.kind === DocumentKind.TARJETA_FRENTE)) {
      docLabels.push('Tarjeta (frente)');
    }
    if (docs.some((d) => d.kind === DocumentKind.TARJETA_REVERSO)) {
      docLabels.push('Tarjeta (reverso)');
    }
  }
  if (docs.some((d) => d.kind === DocumentKind.FIRMA)) {
    docLabels.push('Firma');
  }
  if (docs.some((d) => d.kind === DocumentKind.TICKET_PAGO)) {
    docLabels.push('Ticket de pago');
  }
  if (docs.some((d) => d.kind === DocumentKind.COMP_TRANSFERENCIA)) {
    docLabels.push('Comprobante de transferencia');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARATULA)) {
    docLabels.push('Carátula');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARTA_FACTURA)) {
    docLabels.push('Carta de requerimiento de factura');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARTA_NO_FACTURA)) {
    docLabels.push('Consentimiento de no factura');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARTA_EXCLUSIONES)) {
    docLabels.push('Carta de aceptación de exclusiones');
  }
  if (docs.some((d) => d.kind === DocumentKind.REGLAMENTO_PARQUE)) {
    docLabels.push('Reglamento de parque');
  }
  if (docs.some((d) => d.kind === DocumentKind.REGLAMENTO_FOLLETO)) {
    docLabels.push('Reglamento de parque (artículos)');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARTA_AUTORIZACION)) {
    docLabels.push('Carta de autorización');
  }
  if (docs.some((d) => d.kind === DocumentKind.CARTA_NOMINA)) {
    docLabels.push('Carta de consentimiento (nómina)');
  }
  if (docs.some((d) => d.kind === DocumentKind.RECIBO_NOMINA)) {
    docLabels.push('Recibo de nómina más actual');
  }
  if (docs.some((d) => d.kind === DocumentKind.BANORTE_DOM)) {
    docLabels.push('Documento de domiciliación Banorte');
  }
  const docsOnDrive = docs.filter((d) => d.driveFileId).length;

  const snap: Record<string, unknown> = {
    sellerName: sale.sellerName,
    titularName: sale.titularName || (h ? fullName(h) : ''),
    status: sale.status,
    amount: Number(sale.amount) || 0,
    fecha: sale.fecha ?? '',
    contrato: realContrato(sale.contrato),
    origenVenta: sale.origenVenta,
    sucursal: sale.branchName || sale.branchId,
    tipoServicio: sale.serviceTypeName || sale.serviceTypeId,
    folioSolicitud: formatDigitalFolio(sale.folioSolicitud || sale.id),
    curp: h?.curp ?? '',
    celular: h?.celular1 ?? '',
    correo: h?.correo ?? '',
    municipio: h?.municipio ?? '',
    estado: h?.estado ?? '',
    planKind: sale.planKind,
    nombrePlan: sale.nombrePlan,
    productId: sale.productId,
    servicioFunerario: sale.servicioFunerario,
    beneficiario1: bens[0] ? fullName(bens[0]) : '',
    beneficiario1Parentesco: bens[0]?.parentesco ?? '',
    beneficiario2: bens[1] ? fullName(bens[1]) : '',
    segundoContacto: sc ? fullName(sc) : '',
    documentos: docLabels.join(', '),
  };

  if (sale.planKind === PlanKind.PARQUE) {
    snap.parqueFuneral = sale.parqueFuneral;
    snap.seccion = sale.seccion;
    snap.cuadrante = sale.cuadrante;
    snap.numero = sale.numero;
    snap.preasignacion = sale.preasignacion ? 'Sí' : 'No';
  }

  if (sale.precioPlan || sale.formaPago || sale.anticipo) {
    snap.precioPlan = sale.precioPlan;
    snap.anticipo = sale.anticipo;
    snap.pagoInicial = sale.pagoInicial;
    snap.frecuencia = sale.frecuencia;
    snap.plazo = sale.plazo;
    snap.importeCadaPago = sale.importeCadaPago;
    snap.saldo = sale.saldo;
    snap.formaPago = sale.formaPago;
    snap.banco = sale.banco;
    snap.cuenta = sale.cuenta;
    snap.bancoPago = sale.bancoPago;
    snap.cuentaPago = sale.cuentaPago;
    if (sale.montoRecibido) snap.montoRecibido = sale.montoRecibido;
    if (sale.cambio) snap.cambio = sale.cambio;
    snap.nombreAsesor = sale.nombreAsesor;
    snap.nombreJefeVentas = sale.nombreJefeVentas;
  }

  if (sale.driveFolderUrl) {
    snap.driveFolderUrl = sale.driveFolderUrl;
  }
  if (sale.driveFolderPath) {
    snap.driveFolderPath = sale.driveFolderPath;
  }
  if (docsOnDrive > 0) {
    snap.documentosEnDrive = docsOnDrive;
  }

  // Quitar vacíos para no saturar la bitácora
  for (const key of Object.keys(snap)) {
    const v = snap[key];
    if (v === '' || v === null || v === undefined) delete snap[key];
  }
  return snap;
}

export function applyPayloadToSale(sale: Sale, payload: SaleFormPayloadDto) {
  const meta = payload.meta ?? {};
  const plan = payload.ubicacionPlan ?? {};
  const decl = payload.declaraciones ?? {};
  const pago = payload.pago ?? {};

  sale.fecha = dateOrNull(meta.fecha);
  // `contrato` solo lo pone Odoo (Generar cotización). El front no lo captura.
  sale.origenVenta = s(meta.origenVenta);
  sale.branchId = optionalInt(meta.branchId);
  sale.branchName = s(meta.branchName);
  sale.serviceTypeId = optionalInt(meta.serviceTypeId);
  sale.serviceTypeName = s(meta.serviceTypeName);
  // folioSolicitud: lo asigna el servidor (D-{id de venta})
  sale.fechaServicio = dateOrNull(meta.fechaServicio);
  sale.estatus =
    estatusFromTipoVenta(meta.tipoVenta) || s(meta.estatus, 'ACTIVO');
  sale.anterior = s(meta.anterior);
  sale.verificacion = s(meta.verificacion);
  sale.reconocimientoVentas = stringifyReconocimientoVentas(
    meta.reconocimientoVentas,
  );

  const kind = s(plan.planKind).toUpperCase();
  sale.planKind =
    kind === PlanKind.PARQUE ? PlanKind.PARQUE : PlanKind.PLAN_FUTURO;
  sale.nombrePlan = s(plan.nombrePlan);
  const pid = plan.productId;
  sale.productId =
    pid == null || pid === ('' as any) || Number.isNaN(Number(pid))
      ? null
      : Number(pid);
  sale.productDefaultCode = s(plan.productDefaultCode);
  if (s(plan.precioPlan)) {
    sale.precioPlan = s(plan.precioPlan);
  }
  sale.servicioFunerario = s(plan.servicioFunerario);
  const preasig = Boolean(plan.preasignacion);
  sale.preasignacion = sale.planKind === PlanKind.PARQUE && preasig;
  sale.withoutInterest = Boolean(plan.withoutInterest);
  if (sale.preasignacion) {
    sale.seccion = s(plan.seccion);
    sale.cuadrante = s(plan.cuadrante);
    sale.numero = s(plan.numero);
    sale.parqueFuneral = s(plan.parqueFuneral);
    sale.parkId = optionalInt(plan.parkId);
    sale.sectionId = optionalInt(plan.sectionId);
    sale.quadrantId = optionalInt(plan.quadrantId);
    sale.spaceId = optionalInt(plan.spaceId);
  } else {
    sale.seccion = '';
    sale.cuadrante = '';
    sale.numero = '';
    sale.parqueFuneral = '';
    sale.parkId = null;
    sale.sectionId = null;
    sale.quadrantId = null;
    sale.spaceId = null;
  }

  // Pago: en captura ya vienen anticipo/importes; no pisar precio del plan con vacío
  if (payload.pago) {
    if (s(pago.precioPlan)) sale.precioPlan = s(pago.precioPlan);
    sale.frecuencia = s(pago.frecuencia);
    // `promocionDescuento` guarda el % de descuento (0–100)
    const descRaw = s(pago.promocionDescuento);
    sale.promocionDescuento = descRaw ? String(money(descRaw)) : '';
    sale.anticipo = s(pago.anticipo);
    sale.pagoInicial = s(pago.pagoInicial);
    sale.plazo = s(pago.plazo);
    sale.importeCadaPago = s(pago.importeCadaPago);
    sale.saldo = computeSaldo(
      sale.precioPlan,
      sale.promocionDescuento,
      sale.anticipo,
      recognizedFromVentas(sale.reconocimientoVentas),
    );
    sale.fechaProximoPago = dateOrNull(pago.fechaProximoPago);
    sale.diasEspecificosPago = s(pago.diasEspecificosPago);
    sale.formaPago = s(pago.formaPago);
    sale.cuenta = s(pago.cuenta);
    sale.banco = s(pago.banco);
    sale.vencimientoTarjeta = s(pago.vencimientoTarjeta);
    sale.titularTarjeta = s(pago.titularTarjeta);
    sale.cvv = s(pago.cvv);
    sale.numeroEmpleado = s(pago.numeroEmpleado);
    sale.nombreEmpleado = s(pago.nombreEmpleado);
    sale.empresaNomina = s(pago.empresaNomina);
    sale.empresaNominaId = optionalInt(pago.empresaNominaId);
    sale.infoNomina = s(pago.infoNomina);
    sale.montoRecibido = s(pago.montoRecibido);
    sale.cambio = s(pago.cambio);
    sale.nombreAsesor = s(pago.nombreAsesor);
    sale.nombreJefeVentas = s(pago.nombreJefeVentas);
  }

  sale.aceptaMercadotecnia = s(decl.aceptaMercadotecnia);
  sale.aceptaPublicidad = s(decl.aceptaPublicidad);

  const c = payload.contacto ?? {};
  if (!sale.holder) sale.holder = new SaleHolder();
  const h = sale.holder;
  h.apellidoPaterno = s(c.apellidoPaterno);
  h.apellidoMaterno = s(c.apellidoMaterno);
  h.nombres = s(c.nombres);
  h.sexo = s(c.sexo);
  h.curp = s(c.curp).toUpperCase();
  h.factura = s(c.factura);
  h.tipoPersona = s(c.tipoPersona).toUpperCase();
  h.razonSocial = s(c.razonSocial);
  h.rfc = s(c.rfc).toUpperCase();
  h.facturaCp = s(c.facturaCp);
  h.regimenFiscal = s(c.regimenFiscal).toUpperCase();
  h.regimenFiscalOtro = s(c.regimenFiscalOtro);
  h.telefonoFactura = normalizeMxPhone(c.telefonoFactura);
  h.fechaNacimiento = dateOrNull(c.fechaNacimiento);
  h.estadoCivil = s(c.estadoCivil);
  h.sindicalizado = s(c.sindicalizado);
  h.observaciones = s(c.observaciones);
  h.celular1 = normalizeMxPhone(c.celular1);
  h.celular2 = normalizeMxPhone(c.celular2);
  h.correo = s(c.correo);
  h.direccion = s(c.direccion);
  h.colonia = s(c.colonia);
  h.cp = s(c.cp);
  h.entreCalles = s(c.entreCalles);
  h.senaParticular = s(c.senaParticular);
  h.municipio = s(c.municipio);
  h.estado = s(c.estado);
  h.tipoCobranza = s(c.tipoCobranza);
  h.domicilioEntregaDocumentacion = s(c.domicilioEntregaDocumentacion);

  const sc = payload.segundoContacto ?? {};
  if (!sale.secondContact) sale.secondContact = new SaleSecondContact();
  const s2 = sale.secondContact;
  s2.apellidoPaterno = s(sc.apellidoPaterno);
  s2.apellidoMaterno = s(sc.apellidoMaterno);
  s2.nombres = s(sc.nombres);
  s2.celular = normalizeMxPhone(sc.celular);
  s2.parentesco = s(sc.parentesco);
  s2.relationId =
    sc.relationId != null && Number(sc.relationId) > 0
      ? Number(sc.relationId)
      : null;
  s2.direccion = s(sc.direccion);
  s2.colonia = s(sc.colonia);
  s2.cp = s(sc.cp);
  s2.entreCalles = s(sc.entreCalles);
  s2.fechaNacimiento = dateOrNull(sc.fechaNacimiento);
  s2.domicilioEntregaDocumentacion = s(sc.domicilioEntregaDocumentacion);

  const ts = payload.derechohabientes?.titularSustituto;
  if (ts && (s(ts.nombres) || s(ts.apellidoPaterno) || s(ts.apellidoMaterno))) {
    if (!sale.substituteHolder) sale.substituteHolder = new SaleSubstituteHolder();
    applyBenPayload(sale.substituteHolder, ts);
  } else {
    sale.substituteHolder = null;
  }

  let list = payload.beneficiarios;
  if (!list?.length && (payload as { derechohabientes?: unknown }).derechohabientes) {
    const d = (payload as {
      derechohabientes: {
        primerBeneficiario?: SaleFormPayloadDto['beneficiarios'] extends (infer U)[] | undefined ? U : never;
        segundoBeneficiario?: SaleFormPayloadDto['beneficiarios'] extends (infer U)[] | undefined ? U : never;
      };
    }).derechohabientes;
    list = [d.primerBeneficiario, d.segundoBeneficiario].filter(
      (x) => x && (s(x.nombres) || s(x.apellidoPaterno)),
    ) as SaleFormPayloadDto['beneficiarios'];
  }

  const beneficiaries: SaleBeneficiary[] = [];
  (list ?? []).slice(0, 2).forEach((b, i) => {
    const row = new SaleBeneficiary();
    row.sortOrder = i;
    row.apellidoPaterno = s(b.apellidoPaterno);
    row.apellidoMaterno = s(b.apellidoMaterno);
    row.nombres = s(b.nombres);
    row.parentesco = s(b.parentesco);
    row.relationId =
      b.relationId != null && Number(b.relationId) > 0
        ? Number(b.relationId)
        : null;
    row.celular = normalizeMxPhone(b.celular);
    row.fechaNacimiento = dateOrNull(b.fechaNacimiento);
    beneficiaries.push(row);
  });
  sale.beneficiaries = beneficiaries;

  const docs: SaleDocument[] = [];
  const existingByKind = new Map(
    (sale.documents ?? []).map((d) => [d.kind, d] as const),
  );
  const pushDoc = (
    kind: DocumentKind,
    att: {
      name?: string;
      mime?: string;
      dataBase64?: string;
      driveFileId?: string | null;
      driveFileUrl?: string | null;
    } | null | undefined,
  ) => {
    const prev = existingByKind.get(kind);
    if (!att?.dataBase64) {
      // Sin binario nuevo: conservar el adjunto ya persistido (id / Drive / base64)
      if (prev && (prev.id || prev.dataBase64 || prev.driveFileId)) {
        docs.push(prev);
      }
      return;
    }
    const d = prev ?? new SaleDocument();
    d.kind = kind;
    d.name = s(att.name, kind.toLowerCase());
    d.mime = s(att.mime, 'application/octet-stream');
    d.dataBase64 = att.dataBase64;
    // Reemplazo local invalida refs previas de Drive
    d.driveFileId = null;
    d.driveFileUrl = null;
    docs.push(d);
  };
  pushDoc(DocumentKind.INE_FRENTE, payload.documentos?.ineFrente);
  pushDoc(DocumentKind.INE_REVERSO, payload.documentos?.ineReverso);
  pushDoc(
    DocumentKind.INE,
    payload.documentos?.inePdf ?? payload.documentos?.ine,
  );
  pushDoc(DocumentKind.COMPROBANTE, payload.documentos?.comprobanteDomicilio);
  if (needsCardDocumentos(c.tipoCobranza, payload.pago)) {
    pushDoc(DocumentKind.TARJETA_FRENTE, payload.documentos?.tarjetaFrente);
    pushDoc(DocumentKind.TARJETA_REVERSO, payload.documentos?.tarjetaReverso);
    pushDoc(DocumentKind.TARJETA, payload.documentos?.tarjetaPdf);
  }
  if (isNominaTipo(c.tipoCobranza)) {
    pushDoc(DocumentKind.RECIBO_NOMINA, payload.documentos?.reciboNomina);
    if (isUasConvenioPago(payload.pago)) {
      pushDoc(
        DocumentKind.BANORTE_DOM,
        payload.documentos?.domiciliacionBanorte,
      );
    }
  }
  if (s(c.factura).toUpperCase() === 'SI') {
    pushDoc(
      DocumentKind.CONSTANCIA_FISCAL,
      payload.documentos?.constanciaSituacionFiscal,
    );
  }
  pushDoc(DocumentKind.FIRMA, payload.documentos?.firmaCliente);
  pushDoc(DocumentKind.TICKET_PAGO, payload.documentos?.ticketPago);
  pushDoc(
    DocumentKind.COMP_TRANSFERENCIA,
    payload.documentos?.comprobanteTransferencia,
  );
  sale.documents = docs;

  sale.titularName = fullName(h) || sale.titularName;
  if (sale.precioPlan) {
    const n = Number(String(sale.precioPlan).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) sale.amount = n.toFixed(2);
  }
}
