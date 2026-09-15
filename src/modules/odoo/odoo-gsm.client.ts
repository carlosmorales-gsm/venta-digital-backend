import { Injectable, Logger, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export type OdooPlanProduct = {
  id: number;
  name: string;
  listPrice: number;
  defaultCode: string | null;
  companyId: number;
  isPlanProduct: boolean;
  /** product.template.without_interest */
  withoutInterest: boolean;
};

export type OdooUbicacionOption = {
  id: number;
  name: string;
  code?: string | null;
  status?: string | null;
};

export type OdooClienteContacto = {
  apellidoPaterno: string;
  apellidoMaterno: string;
  nombres: string;
  sexo: string;
  curp: string;
  factura: string;
  tipoPersona?: string;
  razonSocial?: string;
  rfc?: string;
  facturaCp?: string;
  regimenFiscal?: string;
  regimenFiscalOtro?: string;
  telefonoFactura?: string;
  direccion: string;
  colonia: string;
  cp: string;
  entreCalles: string;
  senaParticular: string;
  municipio: string;
  estado: string;
  tipoCobranza: string;
  fechaNacimiento: string;
  sindicalizado: string;
  observaciones: string;
  celular1: string;
  celular2: string;
  correo: string;
  estadoCivil: string;
  domicilioEntregaDocumentacion: string;
};

export type OdooClienteSegundo = {
  apellidoPaterno: string;
  apellidoMaterno: string;
  nombres: string;
  celular: string;
  parentesco: string;
  direccion: string;
  colonia: string;
  cp: string;
  entreCalles: string;
  fechaNacimiento: string;
  domicilioEntregaDocumentacion: string;
};

export type OdooClienteBeneficiary = {
  apellidoPaterno: string;
  apellidoMaterno: string;
  nombres: string;
  parentesco: string;
  celular: string;
  fechaNacimiento: string;
};

export type OdooCliente = {
  id: number;
  name: string;
  contacto: OdooClienteContacto;
  segundoContacto: OdooClienteSegundo | null;
  titularSustituto: OdooClienteBeneficiary;
  beneficiarios: OdooClienteBeneficiary[];
};

export type OdooVentaSuspendida = {
  id: number;
  folio: string;
  partnerId: number;
  partnerName: string;
  dateOrder: string;
  amountTotal: number;
  saldo: number;
  matchType: 'titular' | 'beneficiario';
  matchedBeneficiaryName: string;
};

export type OdooVentasSuspendidas = {
  titular: OdooVentaSuspendida[];
  beneficiario: OdooVentaSuspendida[];
};

export type OdooReserveSpaceResult = {
  spaceId: number;
  status: string;
  previousStatus: string;
  name: string;
  code: string | null;
  note: string;
  alreadyReserved?: boolean;
};

/** Cliente/cotización ya persistidos en el expediente virtual de Odoo. */
export type OdooVdReceptionLink = {
  vdSaleId: number;
  partnerId: number;
  saleOrderId: number;
  contrato: string;
};

@Injectable()
export class OdooGsmClient {
  private readonly logger = new Logger(OdooGsmClient.name);
  private readonly http: AxiosInstance | null;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (config.get<string>('API_ODOO_GSM_URL') || '').replace(
      /\/$/,
      '',
    );
    if (!this.baseUrl) {
      this.http = null;
      this.logger.warn(
        'API_ODOO_GSM_URL no configurado; búsqueda de planes deshabilitada',
      );
      return;
    }
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  isConfigured() {
    return Boolean(this.http);
  }

  private mapPlan(row: Record<string, unknown>): OdooPlanProduct {
    const company = row.companyId ?? row.company_id;
    return {
      id: Number(row.id) || 0,
      name: String(row.name || ''),
      listPrice: Number(row.listPrice ?? row.list_price) || 0,
      defaultCode:
        (row.defaultCode as string | null | undefined) ??
        (row.default_code as string | null | undefined) ??
        null,
      companyId: Array.isArray(company) ? Number(company[0]) || 0 : Number(company) || 0,
      isPlanProduct: Boolean(row.isPlanProduct ?? row.is_plan_product),
      withoutInterest: Boolean(row.withoutInterest ?? row.without_interest),
    };
  }

  /**
   * companyId Odoo: 1 Parque · 2 Plan a futuro
   */
  async getPlanesByIds(companyId: 1 | 2, ids: number[]) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
    if (!uniqueIds.length) return [];
    try {
      const { data } = await this.http.get<OdooPlanProduct[]>(
        '/productos/planes',
        { params: { companyId, ids: uniqueIds.join(',') } },
      );
      const rows = (Array.isArray(data) ? data : []).map((row) =>
        this.mapPlan(row as unknown as Record<string, unknown>),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      return uniqueIds.map((id) => byId.get(id)).filter(Boolean) as OdooPlanProduct[];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar planes en Odoo';
      this.logger.error(`getPlanesByIds: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar planes en Odoo',
      );
    }
  }

  async searchPlanes(companyId: 1 | 2, q: string, limit = 20) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<OdooPlanProduct[]>(
        '/productos/planes',
        { params: { companyId, q, limit } },
      );
      return (Array.isArray(data) ? data : []).map((row) =>
        this.mapPlan(row as unknown as Record<string, unknown>),
      );
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar planes en Odoo';
      this.logger.error(`searchPlanes: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar planes en Odoo',
      );
    }
  }

  private async getUbicaciones<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<T>(path, { params });
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar ubicaciones en Odoo';
      this.logger.error(`${path}: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar ubicaciones en Odoo',
      );
    }
  }

  async listServiceTypes() {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<Array<{ id: number; name: string }>>(
        '/productos/tipos-servicio',
      );
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar tipos de servicio en Odoo';
      this.logger.error(`listServiceTypes: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar tipos de servicio en Odoo',
      );
    }
  }

  async listConvenioCompanies() {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<
        Array<{ id: number; name: string; attention?: string | null }>
      >('/productos/empresas-convenio');
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar empresas de convenio';
      this.logger.error(`listConvenioCompanies: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string'
          ? msg
          : 'Error al consultar empresas de convenio',
      );
    }
  }

  async listBranches() {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<Array<{ id: number; name: string }>>(
        '/productos/sucursales',
      );
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar sucursales en Odoo';
      this.logger.error(`listBranches: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar sucursales en Odoo',
      );
    }
  }

  /** Catálogo sale.order.relation (`sale.order.beneficiary.relation_id`). */
  async listParentescos() {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.get<Array<{ id: number; name: string }>>(
        '/productos/parentescos',
      );
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'Error al consultar parentescos en Odoo';
      this.logger.error(`listParentescos: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'Error al consultar parentescos en Odoo',
      );
    }
  }

  async searchClientes(q: string, limit = 20) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Búsqueda de clientes no configurada',
      );
    }
    try {
      const { data } = await this.http.get<OdooCliente[]>('/clientes', {
        params: { q, limit },
      });
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'No se pudo buscar el cliente';
      this.logger.error(`searchClientes: ${msg}`);
      if (status === 400) {
        throw new BadRequestException(
          typeof msg === 'string' ? msg : 'Indica el nombre del cliente',
        );
      }
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'No se pudo buscar el cliente',
      );
    }
  }

  async getCliente(id: number) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Búsqueda de clientes no configurada',
      );
    }
    try {
      const { data } = await this.http.get<OdooCliente>(`/clientes/${id}`);
      return data;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'No se pudo leer el cliente';
      this.logger.error(`getCliente: ${msg}`);
      if (status === 404 || status === 400) {
        throw new BadRequestException(
          typeof msg === 'string' ? msg : 'Cliente no encontrado',
        );
      }
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'No se pudo leer el cliente',
      );
    }
  }

  async listClienteSuspendidas(id: number) {
    return this.listClienteVentas(id, 'suspendidas');
  }

  async listClienteActivas(id: number) {
    return this.listClienteVentas(id, 'activas');
  }

  private async listClienteVentas(
    id: number,
    kind: 'suspendidas' | 'activas',
  ) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Búsqueda de clientes no configurada',
      );
    }
    const label =
      kind === 'activas' ? 'ventas activas' : 'ventas suspendidas';
    try {
      const { data } = await this.http.get<OdooVentasSuspendidas>(
        `/clientes/${id}/${kind}`,
      );
      return {
        titular: Array.isArray(data?.titular) ? data.titular : [],
        beneficiario: Array.isArray(data?.beneficiario)
          ? data.beneficiario
          : [],
      };
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        `No se pudieron leer las ${label}`;
      this.logger.error(`listClienteVentas(${kind}): ${msg}`);
      if (status === 404 || status === 400) {
        throw new BadRequestException(
          typeof msg === 'string' ? msg : 'Cliente no encontrado',
        );
      }
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : `No se pudieron leer las ${label}`,
      );
    }
  }

  searchParques(q?: string, limit = 20) {
    return this.getUbicaciones<OdooUbicacionOption>('/ubicaciones/parques', {
      q: q?.trim() || undefined,
      limit,
    });
  }

  searchSecciones(parkId: number, q?: string, limit = 20) {
    return this.getUbicaciones<OdooUbicacionOption>('/ubicaciones/secciones', {
      parkId,
      q: q?.trim() || undefined,
      limit,
    });
  }

  searchCuadrantes(
    parkId: number,
    sectionId: number,
    q?: string,
    limit = 20,
  ) {
    return this.getUbicaciones<OdooUbicacionOption>(
      '/ubicaciones/cuadrantes',
      {
        parkId,
        sectionId,
        q: q?.trim() || undefined,
        limit,
      },
    );
  }

  searchEspacios(
    parkId: number,
    sectionId: number,
    quadrantId: number,
    q?: string,
    limit = 20,
  ) {
    return this.getUbicaciones<OdooUbicacionOption>('/ubicaciones/espacios', {
      parkId,
      sectionId,
      quadrantId,
      q: q?.trim() || undefined,
      limit,
    });
  }

  async syncVdReception(payload: Record<string, unknown>) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.post<{
        receptionId: number;
        created: boolean;
      }>('/expedientes/venta-digital', payload, { timeout: 120000 });
      return data;
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        (Array.isArray(e?.response?.data?.message)
          ? e.response.data.message.join(', ')
          : null) ||
        e?.message ||
        'No se pudo guardar el expediente en Odoo';
      this.logger.error(`syncVdReception: ${msg}`);
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'No se pudo guardar el expediente en Odoo',
      );
    }
  }

  async reserveSpace(input: {
    spaceId: number;
    folio: string;
    sellerName: string;
  }) {
    if (!this.http) {
      throw new ServiceUnavailableException(
        'Integración Odoo no configurada (API_ODOO_GSM_URL)',
      );
    }
    try {
      const { data } = await this.http.post<OdooReserveSpaceResult>(
        '/ubicaciones/espacios/reservar',
        input,
      );
      return data;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.message ||
        (Array.isArray(e?.response?.data?.message)
          ? e.response.data.message.join(', ')
          : null) ||
        e?.message ||
        'No se pudo apartar la ubicación en Odoo';
      this.logger.error(`reserveSpace: ${msg}`);
      if (status === 409 || status === 400 || status === 404) {
        throw new BadRequestException(
          typeof msg === 'string' ? msg : 'No se pudo apartar la ubicación',
        );
      }
      throw new ServiceUnavailableException(
        typeof msg === 'string' ? msg : 'No se pudo apartar la ubicación en Odoo',
      );
    }
  }

  /**
   * Ventas firmadas sin id de cliente/cotización: api-odoo-gsm lee el
   * expediente y, si Mesa ya asoció, Nest copia esos IDs.
   */
  async getVdReceptionLinks(
    vdSaleIds: number[],
  ): Promise<OdooVdReceptionLink[]> {
    if (!this.http) return [];
    const ids = [
      ...new Set(vdSaleIds.filter((id) => Number.isFinite(id) && id > 0)),
    ];
    if (!ids.length) return [];
    try {
      const { data } = await this.http.get<{ items?: OdooVdReceptionLink[] }>(
        '/expedientes/venta-digital/enlaces',
        { params: { ids: ids.join(',') }, timeout: 8000 },
      );
      const rows = Array.isArray(data) ? data : data?.items ?? [];
      return rows
        .map((row) => ({
          vdSaleId: Number(row.vdSaleId) || 0,
          partnerId: Number(row.partnerId) || 0,
          saleOrderId: Number(row.saleOrderId) || 0,
          contrato: String(row.contrato || ''),
        }))
        .filter((row) => row.vdSaleId > 0);
    } catch (e: any) {
      this.logger.warn(
        `getVdReceptionLinks: ${e?.response?.data?.message || e?.message}`,
      );
      return [];
    }
  }
}
