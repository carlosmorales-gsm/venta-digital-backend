export type CorrectionKind = 'field' | 'document';

export type CorrectionFieldDef = {
  key: string;
  section: string;
  sectionLabel: string;
  label: string;
  kind: CorrectionKind;
};

export type CorrectionReviewItem = {
  key: string;
  label: string;
  previous: string;
  next: string;
};

export type CorrectionRequest = {
  fields: string[];
  returnStatus: string;
  previous: Record<string, string>;
  review: CorrectionReviewItem[];
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
  field('contrato', 'Contrato', 'meta.fechaServicio', 'Fecha de servicio'),

  field('contacto', 'Datos de contacto', 'contacto.nombres', 'Nombre(s)'),
  field('contacto', 'Datos de contacto', 'contacto.apellidoPaterno', 'Apellido paterno'),
  field('contacto', 'Datos de contacto', 'contacto.apellidoMaterno', 'Apellido materno'),
  field('contacto', 'Datos de contacto', 'contacto.curp', 'CURP'),
  field('contacto', 'Datos de contacto', 'contacto.sexo', 'Sexo'),
  field('contacto', 'Datos de contacto', 'contacto.fechaNacimiento', 'Fecha de nacimiento'),
  field('contacto', 'Datos de contacto', 'contacto.estadoCivil', 'Estado civil'),
  field('contacto', 'Datos de contacto', 'contacto.celular1', 'Celular 1'),
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

  doc('ine', 'INE'),
  doc('tarjeta', 'Tarjeta'),
  doc('comprobanteDomicilio', 'Comprobante de domicilio'),
  doc('constanciaSituacionFiscal', 'Constancia de situación fiscal'),
  doc('reciboNomina', 'Recibo de nómina'),
  doc('domiciliacionBanorte', 'Domiciliación Banorte'),
  doc('comprobanteTransferencia', 'Comprobante de transferencia'),
];

/** Datos y archivos que Mesa de Control puede pedir de nuevo. */
export const CORRECTION_KEYS = CORRECTION_FIELDS.map((item) => item.key);

const DOCUMENT_PAIRS: Array<[string, string]> = [
  ['documentos.ineFrente', 'documentos.ineReverso'],
  ['documentos.tarjetaFrente', 'documentos.tarjetaReverso'],
];

/** INE y tarjeta siempre incluyen frente y reverso. */
export function expandCorrectionDocumentKeys(keys: string[]): string[] {
  const set = new Set(keys);
  for (const [front, back] of DOCUMENT_PAIRS) {
    if (set.has(front) || set.has(back)) {
      set.add(front);
      set.add(back);
    }
  }
  return [...set];
}

export type CorrectionFileTarget = {
  saveKey: string;
  label: string;
};

/**
 * Odoo pide “INE” o “Tarjeta” como un solo archivo.
 * Aquí se abre en frente y reverso, que son los archivos que se guardan.
 */
export function correctionFileTargets(keys: string[]): CorrectionFileTarget[] {
  const targets: CorrectionFileTarget[] = [];
  const seen = new Set<string>();
  const push = (saveKey: string, label: string) => {
    if (seen.has(saveKey)) return;
    seen.add(saveKey);
    targets.push({ saveKey, label });
  };
  for (const key of keys) {
    if (
      key === 'documentos.ine' ||
      key === 'documentos.inePdf' ||
      key === 'documentos.ineFrente' ||
      key === 'documentos.ineReverso'
    ) {
      push('documentos.ineFrente', 'INE (frente)');
      push('documentos.ineReverso', 'INE (reverso)');
      continue;
    }
    if (
      key === 'documentos.tarjeta' ||
      key === 'documentos.tarjetaPdf' ||
      key === 'documentos.tarjetaFrente' ||
      key === 'documentos.tarjetaReverso'
    ) {
      push('documentos.tarjetaFrente', 'Tarjeta (frente)');
      push('documentos.tarjetaReverso', 'Tarjeta (reverso)');
      continue;
    }
    const def = correctionFieldByKey(key);
    if (def?.kind === 'document') push(key, def.label);
  }
  return targets;
}

const FIELD_BY_KEY = new Map(CORRECTION_FIELDS.map((item) => [item.key, item]));

export function correctionFieldByKey(key: string): CorrectionFieldDef | undefined {
  return FIELD_BY_KEY.get(key);
}

export function parseCorrectionRequest(raw: string | null | undefined): CorrectionRequest {
  const empty: CorrectionRequest = {
    fields: [],
    returnStatus: '',
    previous: {},
    review: [],
  };
  if (!raw?.trim()) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<CorrectionRequest>;
    const fields = Array.isArray(parsed.fields)
      ? parsed.fields.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const previous: Record<string, string> = {};
    if (parsed.previous && typeof parsed.previous === 'object') {
      for (const [key, value] of Object.entries(parsed.previous)) {
        const name = String(value ?? '').trim();
        if (key.trim() && name) previous[key.trim()] = name;
      }
    }
    const review = Array.isArray(parsed.review)
      ? parsed.review
          .map((item) => ({
            key: String(item?.key || '').trim(),
            label: String(item?.label || '').trim(),
            previous: String(item?.previous || '').trim() || '—',
            next: String(item?.next || '').trim() || '—',
          }))
          .filter((item) => item.key && item.label)
      : [];
    return {
      fields,
      returnStatus: String(parsed.returnStatus || '').trim(),
      previous,
      review,
    };
  } catch {
    return empty;
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
