export type CorrectionKind = 'field' | 'document';

export type CorrectionFieldDef = {
  key: string;
  section: string;
  sectionLabel: string;
  label: string;
  kind: CorrectionKind;
};

export type CorrectionRequest = {
  fields: string[];
  returnStatus: string;
};

const field = (
  section: string,
  sectionLabel: string,
  key: string,
  label: string,
): CorrectionFieldDef => ({
  key,
  section,
  sectionLabel,
  label,
  kind: 'field',
});

const doc = (
  key: string,
  label: string,
): CorrectionFieldDef => ({
  key: `documentos.${key}`,
  section: 'documentos',
  sectionLabel: 'Documentos',
  label,
  kind: 'document',
});

export const CORRECTION_FIELDS: CorrectionFieldDef[] = [
  field('contrato', 'Contrato', 'meta.origenVenta', 'Origen de venta'),
  field('contrato', 'Contrato', 'meta.branchName', 'Sucursal'),
  field('contrato', 'Contrato', 'meta.serviceTypeName', 'Tipo de servicio'),
  field('contrato', 'Contrato', 'meta.folioSolicitud', 'Folio de solicitud'),
  field('contrato', 'Contrato', 'meta.fechaServicio', 'Fecha de servicio'),
  field('contrato', 'Contrato', 'meta.tipoVenta', 'Tipo de venta'),

  field('contacto', 'Datos de contacto', 'contacto.nombres', 'Nombre(s)'),
  field('contacto', 'Datos de contacto', 'contacto.apellidoPaterno', 'Apellido paterno'),
  field('contacto', 'Datos de contacto', 'contacto.apellidoMaterno', 'Apellido materno'),
  field('contacto', 'Datos de contacto', 'contacto.curp', 'CURP'),
  field('contacto', 'Datos de contacto', 'contacto.sexo', 'Sexo'),
  field('contacto', 'Datos de contacto', 'contacto.fechaNacimiento', 'Fecha de nacimiento'),
  field('contacto', 'Datos de contacto', 'contacto.estadoCivil', 'Estado civil'),
  field('contacto', 'Datos de contacto', 'contacto.celular1', 'Celular 1'),
  field('contacto', 'Datos de contacto', 'contacto.celular2', 'Celular 2'),
  field('contacto', 'Datos de contacto', 'contacto.correo', 'Correo'),
  field('contacto', 'Datos de contacto', 'contacto.direccion', 'Dirección'),
  field('contacto', 'Datos de contacto', 'contacto.colonia', 'Colonia'),
  field('contacto', 'Datos de contacto', 'contacto.cp', 'C.P.'),
  field('contacto', 'Datos de contacto', 'contacto.municipio', 'Municipio'),
  field('contacto', 'Datos de contacto', 'contacto.estado', 'Estado'),
  field('contacto', 'Datos de contacto', 'contacto.entreCalles', 'Entre calles'),
  field('contacto', 'Datos de contacto', 'contacto.observaciones', 'Observaciones'),

  field('factura', 'Factura', 'contacto.factura', '¿Factura?'),
  field('factura', 'Factura', 'contacto.tipoPersona', 'Tipo de persona'),
  field('factura', 'Factura', 'contacto.razonSocial', 'Razón social'),
  field('factura', 'Factura', 'contacto.rfc', 'RFC'),
  field('factura', 'Factura', 'contacto.regimenFiscal', 'Régimen fiscal'),
  field('factura', 'Factura', 'contacto.telefonoFactura', 'Teléfono de factura'),

  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.nombres', 'Nombre(s)'),
  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.apellidoPaterno', 'Apellido paterno'),
  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.apellidoMaterno', 'Apellido materno'),
  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.parentesco', 'Parentesco'),
  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.celular', 'Celular'),
  field('titular', 'Titular sustituto', 'derechohabientes.titularSustituto.fechaNacimiento', 'Fecha de nacimiento'),

  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.nombres', 'Beneficiario 1 · nombre(s)'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.apellidoPaterno', 'Beneficiario 1 · apellido paterno'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.apellidoMaterno', 'Beneficiario 1 · apellido materno'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.parentesco', 'Beneficiario 1 · parentesco'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.celular', 'Beneficiario 1 · celular'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.0.fechaNacimiento', 'Beneficiario 1 · nacimiento'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.nombres', 'Beneficiario 2 · nombre(s)'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.apellidoPaterno', 'Beneficiario 2 · apellido paterno'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.apellidoMaterno', 'Beneficiario 2 · apellido materno'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.parentesco', 'Beneficiario 2 · parentesco'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.celular', 'Beneficiario 2 · celular'),
  field('beneficiarios', 'Beneficiarios', 'beneficiarios.1.fechaNacimiento', 'Beneficiario 2 · nacimiento'),

  field('segundo', '2.º contacto', 'segundoContacto.nombres', 'Nombre(s)'),
  field('segundo', '2.º contacto', 'segundoContacto.apellidoPaterno', 'Apellido paterno'),
  field('segundo', '2.º contacto', 'segundoContacto.apellidoMaterno', 'Apellido materno'),
  field('segundo', '2.º contacto', 'segundoContacto.parentesco', 'Parentesco'),
  field('segundo', '2.º contacto', 'segundoContacto.celular', 'Celular'),
  field('segundo', '2.º contacto', 'segundoContacto.direccion', 'Dirección'),
  field('segundo', '2.º contacto', 'segundoContacto.colonia', 'Colonia'),
  field('segundo', '2.º contacto', 'segundoContacto.cp', 'C.P.'),

  field('plan', 'Plan', 'ubicacionPlan.nombrePlan', 'Plan'),
  field('plan', 'Plan', 'ubicacionPlan.parqueFuneral', 'Parque'),
  field('plan', 'Plan', 'ubicacionPlan.seccion', 'Sección'),
  field('plan', 'Plan', 'ubicacionPlan.cuadrante', 'Cuadrante'),
  field('plan', 'Plan', 'ubicacionPlan.numero', 'Número'),
  field('plan', 'Plan', 'ubicacionPlan.servicioFunerario', 'Servicio funerario'),

  field('pago', 'Pago', 'pago.formaPago', 'Forma de pago'),
  field('pago', 'Pago', 'pago.frecuencia', 'Frecuencia'),
  field('pago', 'Pago', 'pago.plazo', 'Plazo'),
  field('pago', 'Pago', 'pago.anticipo', 'Anticipo'),
  field('pago', 'Pago', 'pago.pagoInicial', 'Pago inicial'),
  field('pago', 'Pago', 'pago.banco', 'Banco de domiciliación'),
  field('pago', 'Pago', 'pago.cuenta', 'Cuenta de domiciliación'),
  field('pago', 'Pago', 'pago.empresaNomina', 'Empresa de convenio'),
  field('pago', 'Pago', 'pago.numeroEmpleado', 'Número de empleado'),

  doc('inePdf', 'INE'),
  doc('comprobanteDomicilio', 'Comprobante de domicilio'),
  doc('constanciaSituacionFiscal', 'Constancia de situación fiscal'),
  doc('tarjetaPdf', 'Tarjeta'),
  doc('reciboNomina', 'Recibo de nómina'),
  doc('domiciliacionBanorte', 'Domiciliación Banorte'),
  doc('firmaCliente', 'Firma del cliente'),
  doc('ticketPago', 'Ticket de pago'),
  doc('comprobanteTransferencia', 'Comprobante de transferencia'),
];

const FIELD_BY_KEY = new Map(CORRECTION_FIELDS.map((item) => [item.key, item]));

export function correctionFieldByKey(key: string): CorrectionFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

export function parseCorrectionRequest(raw: string | null | undefined): CorrectionRequest {
  if (!raw?.trim()) return { fields: [], returnStatus: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<CorrectionRequest>;
    const fields = Array.isArray(parsed.fields)
      ? parsed.fields.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    return {
      fields,
      returnStatus: String(parsed.returnStatus || '').trim(),
    };
  } catch {
    return { fields: [], returnStatus: '' };
  }
}

export function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
      continue;
    }
    return undefined;
  }
  return current;
}

export function writePath(source: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.');
  let current: unknown = source;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = parts[i + 1];
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!current[index] || typeof current[index] !== 'object') {
        current[index] = /^\d+$/.test(next) ? [] : {};
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!record[part] || typeof record[part] !== 'object') {
      record[part] = /^\d+$/.test(next) ? [] : {};
    }
    current = record[part];
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(current)) {
    current[Number(last)] = value;
    return;
  }
  (current as Record<string, unknown>)[last] = value;
}

/** Id de catálogo que acompaña al nombre corregido (sucursal, servicio, parentesco). */
export function correctionCompanionKey(key: string): string | null {
  if (key === 'meta.branchName') return 'meta.branchId';
  if (key === 'meta.serviceTypeName') return 'meta.serviceTypeId';
  if (key === 'pago.empresaNomina') return 'pago.empresaNominaId';
  if (key.endsWith('.parentesco')) return key.replace(/parentesco$/, 'relationId');
  return null;
}

export function displayCorrectionValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    const name = (value as { name?: string }).name;
    return name?.trim() || 'Archivo';
  }
  return String(value);
}
