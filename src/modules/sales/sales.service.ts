import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SalesRepository } from './repositories/sales.repository';
import { SaleStatus } from './enums/sale-status.enum';
import { DocumentKind } from './enums/document-kind.enum';
import { UsersRepository } from '../users/repositories/users.repository';
import { AuditService, diffChanges } from '../audit/audit.service';
import { AuditAction } from '../audit/enums/audit-action.enum';
import { AuditEntityType } from '../audit/enums/audit-entity-type.enum';
import { Sale } from './entities/sale.entity';
import { SaleDocument } from './entities/sale-document.entity';
import { AuthUserPayload } from '../../common/decorators/current-user.decorator';
import { UserType } from '../../common/enums/user-type.enum';
import { GoogleDriveService } from './google-drive.service';
import { TicketNotificationService } from '../notifications/ticket-notification.service';
import {
  SavePaymentDto,
  SignSaleDto,
  UpsertSaleDto,
} from './dto/sale-form.dto';
import {
  applyPayloadToSale,
  computeSaldo,
  fullName,
  isUasConvenioPago,
  needsCardDocumentos,
  realContrato,
  parseReconocimientoVentas,
  recognizedFromVentas,
  saleToAuditSnapshot,
  saleToPayload,
  saleToPublic,
  saleToListItem,
} from './mappers/sale.mapper';
import { assertValidCurp } from './utils/curp';
import { assertMxPhone } from './utils/phone';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SettingsService } from '../settings/settings.service';
import { DiscountsService } from '../discounts/discounts.service';
import { OdooGsmClient, type OdooVdReceptionLink } from '../odoo/odoo-gsm.client';
import { PlanKind } from './enums/plan-kind.enum';
import { CONTRATO_STAMPS, stampTextOnPdf } from './utils/stamp-caratula-contrato';
import { formatDigitalFolio } from './utils/digital-folio';
import {
  correctionCompanionKey,
  correctionFieldByKey,
  correctionFileTargets,
  displayCorrectionValue,
  expandCorrectionDocumentKeys,
  parseCorrectionRequest,
  readPath,
  writePath,
} from './correction-fields';
import {
  correctionTouchesFinance,
  formatCorrectionMoney,
  recomputeCorrectionFinance,
  sameMoney,
} from './utils/financing';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);
  private readonly odooPushInflight = new Set<number>();
  /** Vendedor y jefe ya enviados en esta ejecución del API. */
  private readonly odooPeopleSent = new Map<number, string>();

  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly usersRepository: UsersRepository,
    private readonly auditService: AuditService,
    private readonly googleDrive: GoogleDriveService,
    private readonly settingsService: SettingsService,
    private readonly discountsService: DiscountsService,
    private readonly odooGsm: OdooGsmClient,
    private readonly ticketNotifications: TicketNotificationService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  private parseMoney(v: unknown): number {
    const n = Number(String(v ?? '').replace(/,/g, '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  /** Valida tope de descuento (%) del vendedor y recalcula saldo. */
  private async assertDiscountAndSaldo(sale: Sale, userId: number) {
    const descuento = this.parseMoney(sale.promocionDescuento);
    if (descuento < 0) {
      throw new BadRequestException('El descuento no puede ser negativo');
    }
    if (descuento > 100) {
      throw new BadRequestException('El descuento no puede ser mayor a 100%');
    }
    const max = await this.settingsService.allowedDiscountMaxForUser(userId);
    if (descuento > max + 0.001) {
      throw new BadRequestException(
        `El descuento no puede exceder ${max}%`,
      );
    }
    this.recomputeSaldo(sale);
  }

  /** Recalcula saldo sin revalidar tope (p. ej. pago ya validado al finalizar). */
  private recomputeSaldo(sale: Sale) {
    sale.saldo = computeSaldo(
      sale.precioPlan,
      sale.promocionDescuento,
      sale.anticipo,
      recognizedFromVentas(sale.reconocimientoVentas),
    );
  }

  /** Folio de solicitud = D-{id de venta}. */
  private async syncFolioSolicitud(sale: Sale) {
    const folio = formatDigitalFolio(sale.id);
    if (sale.folioSolicitud === folio) return;
    sale.folioSolicitud = folio;
    await this.salesRepository.saveWithoutDocuments(sale);
  }

  /** Aparta park.space en Odoo cuando la venta tiene preasignación de parque. */
  private async reservePreassignedSpace(sale: Sale) {
    if (
      sale.planKind !== PlanKind.PARQUE ||
      !sale.preasignacion ||
      !sale.spaceId
    ) {
      return;
    }

    if (!this.odooGsm.isConfigured()) {
      throw new BadRequestException(
        'Integración Odoo no configurada; no se pudo apartar la ubicación',
      );
    }

    const folio = sale.folioSolicitud?.trim() || String(sale.id);
    const sellerName = sale.sellerName?.trim() || 'Vendedor';

    await this.odooGsm.reserveSpace({
      spaceId: sale.spaceId,
      folio,
      sellerName,
    });
  }

  /**
   * Arma el JSON del expediente. Odoo, al actualizar, escribe solo lo distinto.
   */
  private async buildVdReceptionPayload(
    saleId: number,
  ): Promise<Record<string, unknown> | null> {
    const sale = await this.salesRepository.findById(saleId);
    if (
      !sale ||
      sale.status === SaleStatus.DRAFT ||
      sale.status === SaleStatus.REJECTED
    ) {
      return null;
    }
    await this.ensureCaratulaFromDrive(sale);
    await this.hydrateAllDocuments(sale);
    const publicSale = saleToPublic(sale);
    const payloadBody =
      publicSale.payload && typeof publicSale.payload === 'object'
        ? (publicSale.payload as Record<string, unknown>)
        : {};
    const pago =
      payloadBody.pago && typeof payloadBody.pago === 'object'
        ? (payloadBody.pago as Record<string, unknown>)
        : {};
    const meta =
      payloadBody.meta && typeof payloadBody.meta === 'object'
        ? { ...(payloadBody.meta as Record<string, unknown>) }
        : {};
    if (String(meta.tipoVenta || '').toUpperCase() === 'FUNEPET' || sale.funepet) {
      meta.tipoVenta = 'NUEVA';
      meta.estatus = 'ACTIVO';
    }
    const vdSellerName = (sale.sellerName || '').trim();
    const vdManagerName = (sale.nombreJefeVentas || '').trim();
    return {
      ...publicSale,
      tipoVenta: sale.funepet ? 'NUEVA' : publicSale.tipoVenta,
      sellerId: 2,
      sellerName: '',
      vdSellerName,
      vdManagerName,
      payload: {
        ...payloadBody,
        meta,
        pago: {
          ...pago,
          nombreAsesor: '',
          nombreJefeVentas: vdManagerName,
        },
      },
    };
  }

  /**
   * Envía o actualiza el expediente virtual en Odoo (Mesa de Control).
   * No revierte la venta si Odoo falla; devuelve el resultado para avisar al front.
   */
  private async syncReceptionToOdoo(
    saleId: number,
  ): Promise<{ synced: boolean; error?: string }> {
    if (!this.odooGsm.isConfigured()) {
      const msg = 'API Odoo no configurada (API_ODOO_GSM_URL)';
      this.logger.warn(`Venta #${saleId}: ${msg}; expediente no sincronizado`);
      return { synced: false, error: msg };
    }

    const sale = await this.salesRepository.findById(saleId);
    if (!sale) {
      return { synced: false, error: 'Venta no encontrada' };
    }

    if (
      sale.status === SaleStatus.DRAFT ||
      sale.status === SaleStatus.REJECTED
    ) {
      return { synced: false, error: 'La venta aún no está lista para Odoo' };
    }

    try {
      const payload = await this.buildVdReceptionPayload(sale.id);
      if (!payload) {
        return { synced: false, error: 'La venta aún no está lista para Odoo' };
      }
      await this.odooGsm.syncVdReception(payload);
      sale.odooReceptionSynced = true;
      await this.salesRepository.saveWithoutDocuments(sale);
      this.odooPeopleSent.set(sale.id, this.receptionPeopleKey(sale));
      this.logger.log(`Expediente Odoo sincronizado para venta #${saleId}`);
      return { synced: true };
    } catch (e) {
      const msg = (e as Error).message || 'Error desconocido';
      this.logger.error(
        `Venta #${saleId}: no se pudo sincronizar expediente Odoo — ${msg}`,
      );
      return { synced: false, error: msg };
    }
  }

  private hasOdooValidationIds(sale: Sale): boolean {
    return Number(sale.odooPartnerId) > 0 && Number(sale.odooSaleOrderId) > 0;
  }

  private isSignedPipeline(sale: Sale): boolean {
    return (
      sale.status === SaleStatus.COMPLETED ||
      sale.status === SaleStatus.PENDING_VALIDATION
    );
  }

  private signedStatusFor(sale: Sale): SaleStatus {
    return this.hasOdooValidationIds(sale)
      ? SaleStatus.COMPLETED
      : SaleStatus.PENDING_VALIDATION;
  }

  private applySignedStatus(sale: Sale): boolean {
    if (!this.isSignedPipeline(sale)) return false;
    const next = this.signedStatusFor(sale);
    if (sale.status === next) return false;
    sale.status = next;
    return true;
  }

  private saleNeedsOdooLinkPull(sale: Sale): boolean {
    return this.isSignedPipeline(sale) && !this.hasOdooValidationIds(sale);
  }

  private applyOdooReceptionLink(
    sale: Sale,
    link: Partial<OdooVdReceptionLink> | null | undefined,
  ) {
    if (!link) return;
    const partnerId = Number(link.partnerId) || 0;
    const saleOrderId = Number(link.saleOrderId) || 0;
    const contrato = String(link.contrato || '').trim();
    if (!(Number(sale.odooPartnerId) > 0) && partnerId > 0) {
      sale.odooPartnerId = partnerId;
    }
    if (
      !(Number(sale.odooSaleOrderId) > 0) &&
      saleOrderId > 0 &&
      Number(sale.odooPartnerId) > 0
    ) {
      sale.odooSaleOrderId = saleOrderId;
      if (contrato) sale.contrato = contrato;
    }
  }

  private receptionPeopleKey(sale: Pick<Sale, 'sellerName' | 'nombreJefeVentas'>): string {
    return `${(sale.sellerName || '').trim()}\n${(sale.nombreJefeVentas || '').trim()}`;
  }

  /** El expediente ya sincronizado no trae estos textos hasta que se reenvían. */
  private receptionPeoplePending(sale: Sale): boolean {
    const key = this.receptionPeopleKey(sale);
    if (key === '\n') return false;
    return this.odooPeopleSent.get(sale.id) !== key;
  }

  private saleReadyForOdooReception(sale: Sale): boolean {
    return (
      sale.status !== SaleStatus.DRAFT && sale.status !== SaleStatus.REJECTED
    );
  }

  /**
   * Al abrir el listado (login): crea el expediente si no está en Odoo
   * y lo actualiza si la venta local cambió después del último envío.
   */
  private async pushUnsyncedReceptionsToOdoo(sales: Sale[]) {
    const eligible = sales.filter((sale) => this.saleReadyForOdooReception(sale));
    if (!eligible.length) return;

    const links = await this.odooGsm.getVdReceptionLinks(
      eligible.map((sale) => sale.id),
    );
    const byId = new Map(links.map((link) => [link.vdSaleId, link]));
    const pending = eligible.filter((sale) => {
      const link = byId.get(sale.id);
      if (!link) return true;
      if (!sale.odooReceptionSynced) return true;
      const odooStatus = String(link.vdSaleStatus || '')
        .trim()
        .toUpperCase();
      if (odooStatus && odooStatus !== String(sale.status).toUpperCase()) {
        return true;
      }
      const odooMs = link.writeDate ? new Date(link.writeDate).getTime() : 0;
      if (Number.isFinite(odooMs) && odooMs > 0) {
        if (sale.updatedAt.getTime() > odooMs + 2500) return true;
      }
      return this.receptionPeoplePending(sale);
    });
    if (!pending.length) return;
    this.logger.log(`Expedientes Odoo a crear o actualizar: ${pending.length}`);
    const payloads: Array<Record<string, unknown>> = [];
    const queued: Sale[] = [];
    for (const sale of pending) {
      if (this.odooPushInflight.has(sale.id)) continue;
      this.odooPushInflight.add(sale.id);
      try {
        const payload = await this.buildVdReceptionPayload(sale.id);
        if (!payload) {
          this.odooPushInflight.delete(sale.id);
          continue;
        }
        payloads.push(payload);
        queued.push(sale);
      } catch (e) {
        this.logger.error(
          `Venta #${sale.id}: no se pudo armar el expediente — ${(e as Error).message}`,
        );
        this.odooPushInflight.delete(sale.id);
      }
    }
    if (!payloads.length) {
      for (const sale of queued) this.odooPushInflight.delete(sale.id);
      return;
    }
    try {
      const items = await this.odooGsm.syncVdReceptionBatch(payloads);
      const byId = new Map(queued.map((sale) => [sale.id, sale]));
      let updated = 0;
      let unchanged = 0;
      for (const item of items) {
        const sale = byId.get(Number(item.id));
        if (!sale) continue;
        if (item.ok === false || !(Number(item.receptionId) > 0)) {
          this.logger.error(
            `Venta #${sale.id}: no se pudo sincronizar expediente Odoo — ${item.error || 'sin expediente'}`,
          );
          continue;
        }
        sale.odooReceptionSynced = true;
        await this.salesRepository.saveWithoutDocuments(sale);
        this.odooPeopleSent.set(sale.id, this.receptionPeopleKey(sale));
        if (item.updated || item.created) updated += 1;
        else unchanged += 1;
      }
      this.logger.log(
        `Lote de expedientes Odoo: ${items.length} (escritos ${updated}, sin cambios ${unchanged})`,
      );
    } catch (e) {
      this.logger.error(
        `No se pudo enviar el lote de expedientes a Odoo — ${(e as Error).message}`,
      );
    } finally {
      for (const sale of queued) this.odooPushInflight.delete(sale.id);
    }
  }

  /**
   * Al abrir la sesión del vendedor: si Mesa ya asoció cliente/cotización
   * y Nest no se enteró (botón oculto en Odoo), copia esos IDs.
   */
  private async pullOdooLinksIfMissing(sales: Sale[]) {
    const pending = sales.filter((sale) => this.saleNeedsOdooLinkPull(sale));
    if (!pending.length) return;
    let links: OdooVdReceptionLink[] = [];
    try {
      links = await this.odooGsm.getVdReceptionLinks(pending.map((sale) => sale.id));
    } catch (e) {
      this.logger.warn(
        `No se pudieron leer enlaces Odoo: ${(e as Error).message}`,
      );
      return;
    }
    if (!links.length) return;
    const byId = new Map(links.map((link) => [link.vdSaleId, link]));
    for (const sale of pending) {
      const link = byId.get(sale.id);
      if (!link) continue;
      const beforePartner = sale.odooPartnerId;
      const beforeOrder = sale.odooSaleOrderId;
      this.applyOdooReceptionLink(sale, link);
      const statusChanged = this.applySignedStatus(sale);
      const contrato = sale.contrato?.trim() || '';
      const gainedQuote =
        !(Number(beforeOrder) > 0) &&
        Number(sale.odooSaleOrderId) > 0 &&
        Boolean(contrato);
      if (
        sale.odooPartnerId !== beforePartner ||
        sale.odooSaleOrderId !== beforeOrder ||
        statusChanged
      ) {
        await this.salesRepository.saveWithoutDocuments(sale);
        this.logger.log(
          `Venta #${sale.id}: sincronizados IDs Odoo (partner=${sale.odooPartnerId ?? 0}, quote=${sale.odooSaleOrderId ?? 0}, status=${sale.status})`,
        );
      }
      if (gainedQuote) {
        await this.refreshContratoOnDriveDocuments(sale, contrato);
      }
    }
  }

  private async refreshSignedStatuses(sales: Sale[]) {
    for (const sale of sales) {
      if (!this.applySignedStatus(sale)) continue;
      await this.salesRepository.saveWithoutDocuments(sale);
    }
  }

  private async draftExpiry(from = new Date()) {
    const { draftTtlHours } = await this.settingsService.getDraftPolicy();
    return new Date(from.getTime() + draftTtlHours * 60 * 60 * 1000);
  }

  private assertSellerOwns(sale: Sale, userId: number) {
    if (sale.sellerId !== userId) {
      throw new ForbiddenException('No puedes acceder a esta venta');
    }
  }

  /** Asesor y jefe de ventas: catálogo del vendedor, no captura por venta. */
  private applySellerCatalogNames(
    sale: Sale,
    seller?: { fullName?: string | null; nombreJefeVentas?: string | null } | null,
  ) {
    const asesor = seller?.fullName?.trim();
    if (asesor) sale.nombreAsesor = asesor;
    const jefe = (seller?.nombreJefeVentas ?? '').trim();
    if (jefe) sale.nombreJefeVentas = jefe;
  }

  private async purgeExpired() {
    const { draftTtlHours } = await this.settingsService.getDraftPolicy();
    try {
      await this.salesRepository.deleteExpiredDrafts(new Date(), draftTtlHours);
    } catch (e) {
      this.logger.warn(
        `No se pudieron borrar borradores vencidos: ${(e as Error).message}`,
      );
    }
  }

  private validateCapture(payload: UpsertSaleDto['payload'], strictDocs: boolean) {
    try {
      assertValidCurp(payload.contacto?.curp);
      assertMxPhone(payload.contacto?.celular1, 'Celular 1 del titular', true);
      assertMxPhone(payload.contacto?.celular2, 'Celular 2 del titular');
      assertMxPhone(
        payload.segundoContacto?.celular,
        'Celular del segundo contacto',
        true,
      );
      assertMxPhone(
        payload.derechohabientes?.titularSustituto?.celular,
        'Celular del titular sustituto',
      );
      const people = payload.beneficiarios ?? [];
      people.forEach((b, i) => {
        assertMxPhone(b?.celular, `Celular del beneficiario ${i + 1}`);
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    const funepet =
      String(payload.meta?.tipoVenta || '').trim().toUpperCase() === 'FUNEPET';
    const bens = payload.beneficiarios ?? [];
    if (funepet) {
      const pet = payload.mascota;
      if (!pet?.name?.trim()) {
        throw new BadRequestException('Captura el nombre de la mascota');
      }
      if (!pet.especieId) {
        throw new BadRequestException('Selecciona la especie de la mascota');
      }
      if (!pet.tamanoId) {
        throw new BadRequestException('Selecciona el tamaño de la mascota');
      }
      if (pet.placaTestigo && !pet.placaTestigoNumero?.trim()) {
        throw new BadRequestException('Captura el número de placa testigo');
      }
    } else {
      const first = bens[0];
      if (!first || (!first.nombres?.trim() && !first.apellidoPaterno?.trim())) {
        throw new BadRequestException('Debes capturar al menos un beneficiario');
      }
      if (bens.length > 2) {
        throw new BadRequestException('Solo puedes agregar hasta 2 beneficiarios');
      }
    }

    const branchId = Number(payload.meta?.branchId);
    if (!Number.isFinite(branchId) || branchId <= 0) {
      throw new BadRequestException('La sucursal es obligatoria');
    }
    const serviceTypeId = Number(payload.meta?.serviceTypeId);
    if (!Number.isFinite(serviceTypeId) || serviceTypeId <= 0) {
      throw new BadRequestException('El tipo de servicio es obligatorio');
    }

    const plan = payload.ubicacionPlan;
    if (String(plan?.planKind || '').toUpperCase() === PlanKind.PARQUE) {
      const parkId = Number(plan?.parkId);
      const sectionId = Number(plan?.sectionId);
      if (!Number.isFinite(parkId) || parkId <= 0 || !(plan?.parqueFuneral || '').trim()) {
        throw new BadRequestException('El parque es obligatorio');
      }
      if (!Number.isFinite(sectionId) || sectionId <= 0 || !(plan?.seccion || '').trim()) {
        throw new BadRequestException('La sección es obligatoria');
      }
      if (plan?.preasignacion) {
        const quadrantId = Number(plan.quadrantId);
        const spaceId = Number(plan.spaceId);
        if (!Number.isFinite(quadrantId) || quadrantId <= 0) {
          throw new BadRequestException('El cuadrante es obligatorio en preasignación');
        }
        if (!Number.isFinite(spaceId) || spaceId <= 0) {
          throw new BadRequestException('La ubicación es obligatoria en preasignación');
        }
      }
    }

    const wantsInvoice =
      (payload.contacto?.factura || '').trim().toUpperCase() === 'SI';
    if (wantsInvoice) {
      const c = payload.contacto ?? {};
      const tipo = (c.tipoPersona || '').trim().toUpperCase();
      if (tipo !== 'FISICA' && tipo !== 'MORAL') {
        throw new BadRequestException('El tipo de persona de factura es obligatorio');
      }
      if (!(c.razonSocial || '').trim()) {
        throw new BadRequestException('La razón social de factura es obligatoria');
      }
      const rfc = (c.rfc || '').trim().toUpperCase();
      if (!/^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(rfc)) {
        throw new BadRequestException('El RFC de factura no es válido');
      }
      const cp = (c.facturaCp || '').replace(/\D/g, '');
      if (cp.length !== 5) {
        throw new BadRequestException('El C.P. de factura debe tener 5 dígitos');
      }
      const regimen = (c.regimenFiscal || '').trim().toUpperCase();
      if (!regimen) {
        throw new BadRequestException('El régimen fiscal es obligatorio');
      }
      if (regimen === 'OTRO' && !(c.regimenFiscalOtro || '').trim()) {
        throw new BadRequestException('Indica el otro régimen fiscal');
      }
      try {
        assertMxPhone(c.telefonoFactura, 'Teléfono de factura', true);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }

    const entregaTitular = (
      payload.contacto?.domicilioEntregaDocumentacion || ''
    ).trim();
    const entregaSegundo = (
      payload.segundoContacto?.domicilioEntregaDocumentacion || ''
    ).trim();
    if (Boolean(entregaTitular) === Boolean(entregaSegundo)) {
      throw new BadRequestException(
        'Indica un solo domicilio para entrega de documentación (titular o segundo contacto)',
      );
    }

    const cobranza = (payload.contacto?.tipoCobranza || '').trim().toUpperCase();
    const pago = payload.pago ?? {};
    if (strictDocs) {
      if (!cobranza) {
        throw new BadRequestException('El tipo de cobranza es obligatorio');
      }
      if (cobranza === 'DOMICILIADO') {
        const card = String(pago.cuenta || '').replace(/\D/g, '');
        if (card.length < 12) {
          throw new BadRequestException('En domiciliación indica el número de tarjeta');
        }
        if (!(pago.vencimientoTarjeta || '').trim()) {
          throw new BadRequestException('En domiciliación indica el vencimiento de la tarjeta');
        }
        if (String(pago.cvv || '').replace(/\D/g, '').length !== 3) {
          throw new BadRequestException('En domiciliación indica los dígitos de seguridad');
        }
        if (!(pago.titularTarjeta || '').trim()) {
          throw new BadRequestException('En domiciliación indica el titular de la tarjeta');
        }
        if (!(pago.banco || '').trim()) {
          throw new BadRequestException('En domiciliación indica el banco');
        }
        if (!(payload.contacto?.correo || '').trim()) {
          throw new BadRequestException('En domiciliación el correo del titular es obligatorio');
        }
      }
      if (cobranza === 'NOMINA' || cobranza === 'NÓMINA') {
        if (!pago.empresaNominaId && !(pago.empresaNomina || '').trim()) {
          throw new BadRequestException('En nómina indica la empresa de convenio');
        }
        if (!(pago.nombreEmpleado || '').trim()) {
          throw new BadRequestException('En nómina indica el nombre del empleado');
        }
        if (!(pago.numeroEmpleado || '').trim()) {
          throw new BadRequestException('En nómina indica el número de empleado');
        }
      }
    }

    if (strictDocs) {
      const hasIne =
        (payload.documentos?.ineFrente &&
          payload.documentos?.ineReverso) ||
        payload.documentos?.inePdf ||
        payload.documentos?.ine;
      const frecuencia = String(payload.pago?.frecuencia || '')
        .trim()
        .toUpperCase();
      const esContado =
        frecuencia === 'CONTADO' ||
        frecuencia.includes('CONTADO') ||
        frecuencia.includes('UNA SOLA');
      const planKind = String(plan?.planKind || '').toUpperCase();
      const omiteDomicilio =
        esContado && planKind === PlanKind.PLAN_FUTURO;
      if (!hasIne) {
        throw new BadRequestException(
          'Debes adjuntar INE (frente y reverso)',
        );
      }
      if (!omiteDomicilio && !payload.documentos?.comprobanteDomicilio) {
        throw new BadRequestException(
          'Debes adjuntar el comprobante de domicilio',
        );
      }
      if (needsCardDocumentos(cobranza, pago)) {
        if (
          !payload.documentos?.tarjetaFrente ||
          !payload.documentos?.tarjetaReverso
        ) {
          throw new BadRequestException(
            cobranza === 'DOMICILIADO'
              ? 'En domiciliación debes adjuntar el frente y el reverso de la tarjeta'
              : 'En UAS debes adjuntar el frente y el reverso de la tarjeta',
          );
        }
      }
      if (cobranza === 'NOMINA' || cobranza === 'NÓMINA') {
        if (!payload.documentos?.reciboNomina) {
          throw new BadRequestException(
            'En nómina debes adjuntar el recibo de nómina más actual',
          );
        }
        if (
          isUasConvenioPago(pago) &&
          !payload.documentos?.domiciliacionBanorte
        ) {
          throw new BadRequestException(
            'En UAS debes adjuntar el documento de domiciliación Banorte',
          );
        }
      }
    }
  }

  async listOwnSales(sellerId: number) {
    await this.purgeExpired();
    const items = await this.salesRepository.findSummariesBySellerId(sellerId);
    await this.pullOdooLinksIfMissing(items);
    await this.refreshSignedStatuses(items);
    void this.pushUnsyncedReceptionsToOdoo(items).catch((e) => {
      this.logger.error(
        `No se pudieron reenviar expedientes a Odoo: ${(e as Error).message}`,
      );
    });
    const now = Date.now();
    const { draftLimit, draftTtlHours } =
      await this.settingsService.getDraftPolicy();
    const ttlMs = draftTtlHours * 60 * 60 * 1000;
    const visible = items.filter((s) => {
      if (s.status !== SaleStatus.DRAFT) return true;
      const created = s.createdAt?.getTime?.() ?? 0;
      if (created && created + ttlMs <= now) return false;
      if (s.draftExpiresAt && s.draftExpiresAt.getTime() <= now) return false;
      return true;
    });
    const drafts = visible.filter((s) => s.status === SaleStatus.DRAFT);
    const pipeline = visible.filter((s) => s.status !== SaleStatus.DRAFT);

    return {
      scope: 'own' as const,
      items: visible.map(saleToListItem),
      drafts: drafts.map(saleToListItem),
      submitted: pipeline.map(saleToListItem),
      draftCount: drafts.length,
      draftLimit,
      draftTtlHours,
      total: visible.length,
      message:
        visible.length === 0
          ? 'Aún no hay ventas registradas para este vendedor'
          : 'Ventas y borradores del vendedor',
    };
  }

  async listAllSales() {
    await this.purgeExpired();
    const items = await this.salesRepository.findForMonitor();
    await this.pullOdooLinksIfMissing(items);
    await this.refreshSignedStatuses(items);
    void this.pushUnsyncedReceptionsToOdoo(items).catch((e) => {
      this.logger.error(
        `No se pudieron reenviar expedientes a Odoo: ${(e as Error).message}`,
      );
    });
    return {
      scope: 'all' as const,
      items: items.map(saleToListItem),
      total: items.length,
      message:
        items.length === 0
          ? 'Aún no hay ventas registradas de vendedores'
          : 'Ventas de todos los vendedores',
    };
  }

  /** Listado liviano para integraciones Odoo (sin adjuntos/base64). */
  async listForConciliation() {
    await this.purgeExpired();
    const items = await this.salesRepository.findForConciliation();
    await this.refreshSignedStatuses(items);
    return {
      scope: 'conciliation' as const,
      total: items.length,
      items: items.map((s) => ({
        id: s.id,
        sellerId: s.sellerId,
        sellerName: s.sellerName,
        nombreJefeVentas: s.nombreJefeVentas ?? '',
        status: s.status,
        titularName: s.titularName,
        odooPartnerId: s.odooPartnerId ?? null,
        odooSaleOrderId: s.odooSaleOrderId ?? null,
        contrato: realContrato(s.contrato),
        nombrePlan: s.nombrePlan ?? '',
        productDefaultCode: s.productDefaultCode ?? '',
        precioPlan: s.precioPlan ?? '',
        promocionDescuento: s.promocionDescuento ?? '',
        anticipo: s.anticipo ?? '',
        saldo: s.saldo ?? '',
        amount: Number(s.amount) || 0,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      })),
    };
  }

  async searchReferences(q?: string, limit = 20) {
    const term = (q || '').trim();
    if (term.length < 3) {
      throw new BadRequestException(
        'Indica al menos 3 caracteres para buscar el cliente',
      );
    }
    await this.purgeExpired();
    const items = await this.salesRepository.searchReferencesByName(term, limit);
    return items.map((s) => ({
      id: s.id,
      sellerId: s.sellerId,
      sellerName: s.sellerName,
      status: s.status,
      titularName: s.titularName,
      amount: Number(s.amount) || 0,
      updatedAt: s.updatedAt.toISOString(),
      payload: saleToPayload(s),
    }));
  }

  /**
   * Si la firma ya no tiene base64 (ventas firmadas antes del fix),
   * la recupera desde Drive para la vista previa del PDF.
   */
  private async hydrateFirmaForPreview(sale: Sale) {
    const firma = (sale.documents ?? []).find(
      (d) => d.kind === DocumentKind.FIRMA,
    );
    if (!firma || firma.dataBase64?.trim() || !firma.driveFileId) return;
    if (!this.googleDrive.isEnabled()) return;

    const downloaded = await this.googleDrive.downloadFileBase64(
      firma.driveFileId,
    );
    if (!downloaded) return;

    firma.dataBase64 = downloaded.dataBase64;
    if (downloaded.mime) firma.mime = downloaded.mime;
    await this.salesRepository.saveDocument(firma);
  }

  /** Ventas ya firmadas: la carátula está en Drive pero no quedó en sale_documents. */
  private async ensureCaratulaFromDrive(sale: Sale) {
    const hasCaratula = sale.documents?.some(
      (d) => d.kind === DocumentKind.CARATULA,
    );
    if (hasCaratula || !sale.driveFolderId) return;

    const found = await this.googleDrive.findCaratulaInFolder(
      sale.driveFolderId,
      sale.id,
    );
    if (!found) return;

    const doc = new SaleDocument();
    doc.kind = DocumentKind.CARATULA;
    doc.name = found.name;
    doc.mime = 'application/pdf';
    doc.driveFileId = found.id;
    doc.driveFileUrl = found.url;
    doc.dataBase64 = null;
    doc.saleId = sale.id;
    sale.documents = [...(sale.documents ?? []), doc];
    await this.salesRepository.saveDocument(doc);
  }

  /** Recupera base64 de adjuntos faltantes en memoria (no reescribe la BD). */
  private async hydrateAllDocuments(sale: Sale) {
    if (!this.googleDrive.isEnabled()) return;
    for (const doc of sale.documents ?? []) {
      if (doc.dataBase64?.trim() || !doc.driveFileId) continue;
      const downloaded = await this.googleDrive.downloadFileBase64(
        doc.driveFileId,
      );
      if (!downloaded) continue;
      doc.dataBase64 = downloaded.dataBase64;
      if (downloaded.mime) doc.mime = downloaded.mime;
    }
  }

  async getOne(id: number, user: AuthUserPayload) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');

    if (user.type === UserType.VENDEDOR) {
      this.assertSellerOwns(sale, user.userId);
      if (
        sale.status === SaleStatus.DRAFT &&
        sale.draftExpiresAt &&
        sale.draftExpiresAt.getTime() <= Date.now()
      ) {
        throw new NotFoundException('El borrador ya expiró');
      }
    }

    await this.hydrateFirmaForPreview(sale);
    return saleToPublic(sale);
  }

  /** Detalle completo para Conciliación Odoo (payload + archivos). */
  async getOneForOdoo(id: number) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findByIdWithFiles(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    await this.ensureCaratulaFromDrive(sale);
    await this.hydrateAllDocuments(sale);
    return saleToPublic(sale);
  }

  /** Asocia un res.partner de Odoo a la venta (Mesa de Control). */
  async setOdooPartner(id: number, odooPartnerId: number) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    sale.odooPartnerId = odooPartnerId;
    this.applySignedStatus(sale);
    await this.salesRepository.saveWithoutDocuments(sale);
    return {
      id: sale.id,
      odooPartnerId: sale.odooPartnerId,
      status: sale.status,
    };
  }

  /**
   * Rechaza una venta desde Odoo (Mesa de Control).
   * Permite cancelar ventas pendientes o ya completadas (expediente cancelado).
   */
  async rejectFromOdoo(id: number, reason: string) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new BadRequestException('El motivo de cancelación es obligatorio');
    }

    if (sale.status === SaleStatus.REJECTED) {
      return {
        id: sale.id,
        status: sale.status,
        alreadyRejected: true,
      };
    }
    if (
      sale.status !== SaleStatus.PENDING_PAYMENT &&
      sale.status !== SaleStatus.PENDING_SIGNATURE &&
      sale.status !== SaleStatus.PENDING_VALIDATION &&
      sale.status !== SaleStatus.COMPLETED
    ) {
      throw new BadRequestException(
        'Solo se pueden cancelar ventas pendientes de pago, de firma, de validación o completadas',
      );
    }

    const before = saleToAuditSnapshot(sale);
    sale.status = SaleStatus.REJECTED;
    sale.odooSaleOrderId = null;
    await this.salesRepository.saveWithoutDocuments(sale);

    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: null,
        fullName: 'Odoo (Mesa de Control)',
        type: 'INTEGRATION',
      },
      action: AuditAction.CANCEL,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `Odoo canceló venta #${sale.id} (${titular})`,
      details: {
        kind: 'changes',
        before,
        after: saleToAuditSnapshot(sale),
        reason: trimmedReason,
      },
    });

    return {
      id: sale.id,
      status: sale.status,
      alreadyRejected: false,
    };
  }

  /** Mesa de Control pide de nuevo los archivos que el vendedor debe subir. */
  async requestCorrectionFromOdoo(id: number, fields: string[]) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');

    const keys = expandCorrectionDocumentKeys(
      [...new Set(fields.map((item) => item.trim()).filter(Boolean))],
    );
    if (!keys.length || keys.some((key) => !correctionFieldByKey(key))) {
      throw new BadRequestException('Selecciona datos de la venta para corregir');
    }

    const allowed = new Set<SaleStatus>([
      SaleStatus.PENDING_PAYMENT,
      SaleStatus.PENDING_SIGNATURE,
      SaleStatus.PENDING_VALIDATION,
      SaleStatus.COMPLETED,
      SaleStatus.PENDING_CORRECTION,
      SaleStatus.PENDING_CORRECTION_REVIEW,
    ]);
    if (!allowed.has(sale.status)) {
      throw new BadRequestException(
        'Esta venta no se puede mandar a corrección',
      );
    }

    const previous = parseCorrectionRequest(sale.correctionRequest);
    const keepReturn =
      sale.status === SaleStatus.PENDING_CORRECTION ||
      sale.status === SaleStatus.PENDING_CORRECTION_REVIEW;
    const returnStatus = keepReturn
      ? previous.returnStatus || SaleStatus.PENDING_VALIDATION
      : sale.status;

    sale.status = SaleStatus.PENDING_CORRECTION;
    sale.correctionRequest = JSON.stringify({
      fields: keys,
      returnStatus,
      previous: this.snapshotCorrectionFiles(sale, keys, previous.previous),
      review: [],
    });
    sale.odooReceptionSynced = false;
    await this.salesRepository.saveWithoutDocuments(sale);
    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';
    const campos = keys
      .map((key) => correctionFieldByKey(key)?.label || key)
      .join(', ');
    await this.auditService.record({
      actor: {
        userId: null,
        fullName: 'Odoo (Mesa de Control)',
        type: 'INTEGRATION',
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `Mesa de Control mandó a corregir venta #${sale.id} (${titular})`,
      details: { kind: 'note', campos },
    });
    void this.syncReceptionToOdoo(sale.id).catch(() => undefined);

    return {
      id: sale.id,
      status: sale.status,
      fields: keys,
    };
  }

  /** El vendedor guarda los datos marcados y la venta vuelve a su estatus anterior. */
  async submitSellerCorrection(
    id: number,
    user: AuthUserPayload,
    values: Record<string, unknown>,
  ) {
    const sale = await this.salesRepository.findByIdWithFiles(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
    if (sale.status !== SaleStatus.PENDING_CORRECTION) {
      throw new BadRequestException('Esta venta no está por corregir');
    }

    const request = parseCorrectionRequest(sale.correctionRequest);
    const requested = expandCorrectionDocumentKeys(request.fields);
    const fileTargets = correctionFileTargets(requested);
    if (!requested.length) {
      throw new BadRequestException('No hay archivos marcados para corregir');
    }

    for (const target of fileTargets) {
      const file = values?.[target.saveKey] as { dataBase64?: string } | undefined;
      if (!file?.dataBase64) {
        throw new BadRequestException(`Adjunta el archivo de ${target.label}`);
      }
    }

    const beforeCorrection = saleToAuditSnapshot(sale);
    const payload = saleToPayload(sale) as unknown as Record<string, unknown>;
    const savedFileKeys = new Set(fileTargets.map((target) => target.saveKey));
    for (const target of fileTargets) {
      const file = values[target.saveKey] as {
        name?: string;
        mime?: string;
        dataBase64?: string;
      };
      writePath(payload, target.saveKey, {
        name: file.name || target.label,
        mime: file.mime || 'application/octet-stream',
        dataBase64: file.dataBase64,
      });
    }
    for (const key of requested) {
      if (savedFileKeys.has(key) || correctionFileTargets([key]).some((t) => t.saveKey !== key)) {
        continue;
      }
      const def = correctionFieldByKey(key);
      if (!def || def.kind === 'document' || !(key in (values || {}))) continue;
      const incoming = values[key];
      writePath(payload, key, incoming == null ? '' : String(incoming));
      const companion = correctionCompanionKey(key);
      if (companion && values?.[companion] != null && values[companion] !== '') {
        const id = Number(values[companion]);
        if (Number.isFinite(id) && id > 0) writePath(payload, companion, id);
      }
    }

    const financeNext = new Map<string, string>();
    const financeReview: Array<{
      key: string;
      label: string;
      previous: string;
      next: string;
    }> = [];
    if (correctionTouchesFinance(requested)) {
      const pago = (readPath(payload, 'pago') ?? {}) as Record<string, unknown>;
      const plan = (readPath(payload, 'ubicacionPlan') ?? {}) as Record<string, unknown>;
      const before = {
        saldo: displayCorrectionValue(pago.saldo),
        cuota: displayCorrectionValue(pago.importeCadaPago),
        dias: displayCorrectionValue(pago.diasEspecificosPago),
        plazo: displayCorrectionValue(pago.plazo),
        inicial: displayCorrectionValue(pago.pagoInicial),
      };
      const frequencyChanged =
        requested.includes('pago.frecuencia') &&
        String(sale.frecuencia || '')
          .trim()
          .toUpperCase() !==
          String(pago.frecuencia || '')
            .trim()
            .toUpperCase();
      const finance = recomputeCorrectionFinance({
        precioPlan: plan.precioPlan || pago.precioPlan,
        descuentoPct: pago.promocionDescuento,
        anticipo: pago.anticipo,
        frecuencia: pago.frecuencia,
        plazo: pago.plazo,
        withoutInterest: Boolean(plan.withoutInterest),
        recognizedBalance: recognizedFromVentas(sale.reconocimientoVentas),
        previousPagoInicial: before.inicial,
        previousDias: before.dias,
        frequencyChanged,
      });
      const derived: Array<{
        key: string;
        label: string;
        previous: string;
        next: string;
        money: boolean;
      }> = [
        {
          key: 'pago.saldo',
          label: 'Pago · Saldo',
          previous: before.saldo,
          next: finance.saldo,
          money: true,
        },
        {
          key: 'pago.importeCadaPago',
          label: 'Pago · Importe de cada pago',
          previous: before.cuota,
          next: finance.importeCadaPago,
          money: true,
        },
      ];
      if (frequencyChanged) {
        derived.push({
          key: 'pago.diasEspecificosPago',
          label: 'Pago · Días específicos de pago',
          previous: before.dias,
          next: finance.diasEspecificosPago,
          money: false,
        });
        derived.push({
          key: 'pago.plazo',
          label: 'Pago · Plazo',
          previous: before.plazo,
          next: finance.plazo,
          money: false,
        });
      }
      if (finance.pagoInicial != null) {
        derived.push({
          key: 'pago.pagoInicial',
          label: 'Pago · Pago inicial',
          previous: before.inicial,
          next: finance.pagoInicial,
          money: true,
        });
      }
      for (const item of derived) {
        writePath(payload, item.key, item.next);
        financeNext.set(item.key, item.next);
        if (requested.includes(item.key)) continue;
        const changed = item.money
          ? !sameMoney(item.previous, item.next)
          : (item.previous.trim() || '—') !== (item.next.trim() || '—');
        if (!changed) continue;
        financeReview.push({
          key: item.key,
          label: item.label,
          previous: item.money
            ? formatCorrectionMoney(item.previous)
            : item.previous.trim() || '—',
          next: item.money
            ? formatCorrectionMoney(item.next)
            : item.next.trim() || '—',
        });
      }
    }

    applyPayloadToSale(sale, payload as never);
    const dropCombined = new Set<DocumentKind>();
    if (savedFileKeys.has('documentos.ineFrente') || savedFileKeys.has('documentos.ineReverso')) {
      dropCombined.add(DocumentKind.INE);
    }
    if (
      savedFileKeys.has('documentos.tarjetaFrente') ||
      savedFileKeys.has('documentos.tarjetaReverso')
    ) {
      dropCombined.add(DocumentKind.TARJETA);
    }
    if (dropCombined.size) {
      sale.documents = (sale.documents ?? []).filter(
        (doc) => !dropCombined.has(doc.kind),
      );
    }
    const review = [
      ...request.fields
        .map((key) => correctionFieldByKey(key))
        .filter((def) => def?.kind === 'field')
        .map((def) => {
          const key = def!.key;
          const overridden = financeNext.has(key);
          const rawNext = overridden
            ? financeNext.get(key) || ''
            : displayCorrectionValue(values[key]);
          const rawPrev = (request.previous[key] || '').trim();
          const asMoney = overridden && key === 'pago.pagoInicial';
          return {
            key,
            label: `${def!.sectionLabel} · ${def!.label}`,
            previous: asMoney
              ? formatCorrectionMoney(rawPrev)
              : rawPrev || '—',
            next: asMoney
              ? formatCorrectionMoney(rawNext)
              : rawNext || '—',
          };
        }),
      ...fileTargets.map((target) => {
        const file = values[target.saveKey] as { name?: string };
        return {
          key: target.saveKey,
          label: target.label,
          previous: (request.previous[target.saveKey] || '').trim() || '—',
          next: file?.name?.trim() || target.label,
        };
      }),
      ...financeReview,
    ];
    sale.status = SaleStatus.PENDING_CORRECTION_REVIEW;
    sale.correctionRequest = JSON.stringify({
      fields: request.fields,
      returnStatus: request.returnStatus,
      previous: request.previous,
      review,
    });
    sale.odooReceptionSynced = false;
    const saved = await this.salesRepository.save(sale);
    const correctionChanges = diffChanges(
      beforeCorrection,
      saleToAuditSnapshot(saved),
    );
    if (Object.keys(correctionChanges).length) {
      const seller = await this.usersRepository.findById(user.userId);
      const titular =
        saved.titularName ||
        (saved.holder ? fullName(saved.holder) : '') ||
        'sin titular';
      await this.auditService.record({
        actor: {
          userId: user.userId,
          fullName: seller?.fullName,
          type: user.type,
        },
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.SALE,
        entityId: saved.id,
        summary: `Corrigió datos de venta #${saved.id} (${titular})`,
        details: { kind: 'changes', changes: correctionChanges },
      });
    }
    void this.syncReceptionToOdoo(saved.id).catch(() => undefined);
    return saleToPublic(saved);
  }

  /** Mesa abre el expediente: la corrección reenviada espera aceptación. */
  async getCorrectionReview(id: number) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (sale.status !== SaleStatus.PENDING_CORRECTION_REVIEW) {
      return { pending: false as const };
    }
    const request = parseCorrectionRequest(sale.correctionRequest);
    return {
      pending: true as const,
      id: sale.id,
      status: sale.status,
      titularName: sale.titularName || '',
      items: request.review,
    };
  }

  /** Acepta la corrección: el expediente recibe los archivos y sigue el flujo. */
  async acceptCorrectionReview(id: number) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (sale.status !== SaleStatus.PENDING_CORRECTION_REVIEW) {
      throw new BadRequestException('Esta corrección ya no está por validar');
    }
    const request = parseCorrectionRequest(sale.correctionRequest);
    const next = Object.values(SaleStatus).includes(request.returnStatus as SaleStatus)
      ? (request.returnStatus as SaleStatus)
      : SaleStatus.PENDING_VALIDATION;
    const returnStatus =
      next === SaleStatus.PENDING_CORRECTION ||
      next === SaleStatus.PENDING_CORRECTION_REVIEW
        ? SaleStatus.PENDING_VALIDATION
        : next;
    const backupStatus = sale.status;
    const backupRequest = sale.correctionRequest;
    sale.status = returnStatus;
    sale.correctionRequest = '';
    sale.odooReceptionSynced = false;
    await this.salesRepository.saveWithoutDocuments(sale);
    const synced = await this.syncReceptionToOdoo(sale.id);
    if (!synced.synced) {
      sale.status = backupStatus;
      sale.correctionRequest = backupRequest;
      sale.odooReceptionSynced = false;
      await this.salesRepository.saveWithoutDocuments(sale);
      throw new ServiceUnavailableException(
        synced.error || 'No se pudo actualizar el expediente en Odoo',
      );
    }
    return { id: sale.id, status: sale.status };
  }

  /** Rechaza la corrección: el vendedor vuelve a ver la venta por corregir. */
  async rejectCorrectionReview(id: number) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (sale.status !== SaleStatus.PENDING_CORRECTION_REVIEW) {
      throw new BadRequestException('Esta corrección ya no está por validar');
    }
    const request = parseCorrectionRequest(sale.correctionRequest);
    const backupStatus = sale.status;
    const backupRequest = sale.correctionRequest;
    sale.status = SaleStatus.PENDING_CORRECTION;
    sale.correctionRequest = JSON.stringify({
      fields: request.fields,
      returnStatus: request.returnStatus,
      previous: request.previous,
      review: [],
    });
    sale.odooReceptionSynced = false;
    await this.salesRepository.saveWithoutDocuments(sale);
    const synced = await this.syncReceptionToOdoo(sale.id);
    if (!synced.synced) {
      sale.status = backupStatus;
      sale.correctionRequest = backupRequest;
      sale.odooReceptionSynced = false;
      await this.salesRepository.saveWithoutDocuments(sale);
      throw new ServiceUnavailableException(
        synced.error || 'No se pudo actualizar el expediente en Odoo',
      );
    }
    return { id: sale.id, status: sale.status, fields: request.fields };
  }

  private snapshotCorrectionFiles(
    sale: Sale,
    keys: string[],
    existing: Record<string, string>,
  ): Record<string, string> {
    const previous = { ...existing };
    const payload = saleToPayload(sale);
    for (const key of keys) {
      const def = correctionFieldByKey(key);
      if (!def || def.kind !== 'field') continue;
      if ((previous[key] || '').trim()) continue;
      previous[key] = displayCorrectionValue(readPath(payload, key)) || '—';
    }
    for (const target of correctionFileTargets(keys)) {
      if ((previous[target.saveKey] || '').trim()) continue;
      previous[target.saveKey] = this.correctionFileName(sale, target.saveKey);
    }
    return previous;
  }

  private correctionFileName(sale: Sale, saveKey: string): string {
    const docs = sale.documents ?? [];
    const nameOf = (kind: DocumentKind) =>
      docs.find((doc) => doc.kind === kind)?.name?.trim() || '';
    if (saveKey === 'documentos.ineFrente') {
      return nameOf(DocumentKind.INE_FRENTE) || nameOf(DocumentKind.INE) || '—';
    }
    if (saveKey === 'documentos.ineReverso') {
      return nameOf(DocumentKind.INE_REVERSO) || '—';
    }
    if (saveKey === 'documentos.tarjetaFrente') {
      return nameOf(DocumentKind.TARJETA_FRENTE) || nameOf(DocumentKind.TARJETA) || '—';
    }
    if (saveKey === 'documentos.tarjetaReverso') {
      return nameOf(DocumentKind.TARJETA_REVERSO) || '—';
    }
    const kindByKey: Record<string, DocumentKind> = {
      'documentos.comprobanteDomicilio': DocumentKind.COMPROBANTE,
      'documentos.constanciaSituacionFiscal': DocumentKind.CONSTANCIA_FISCAL,
      'documentos.reciboNomina': DocumentKind.RECIBO_NOMINA,
      'documentos.domiciliacionBanorte': DocumentKind.BANORTE_DOM,
      'documentos.comprobanteTransferencia': DocumentKind.COMP_TRANSFERENCIA,
    };
    const kind = kindByKey[saveKey];
    return (kind && nameOf(kind)) || '—';
  }

  /** Desvincula la cotización Odoo sin rechazar la venta digital. */
  async clearOdooSaleOrderFromOdoo(id: number, reason: string) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new BadRequestException('El motivo es obligatorio');
    }
    if (sale.status === SaleStatus.REJECTED) {
      throw new BadRequestException(
        'No se puede desvincular cotización de una venta rechazada',
      );
    }
    if (!sale.odooSaleOrderId) {
      return {
        id: sale.id,
        odooSaleOrderId: null,
        alreadyCleared: true,
      };
    }

    const before = saleToAuditSnapshot(sale);
    const previousOrderId = sale.odooSaleOrderId;
    sale.odooSaleOrderId = null;
    sale.contrato = '';
    this.applySignedStatus(sale);
    await this.salesRepository.saveWithoutDocuments(sale);

    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: null,
        fullName: 'Odoo (Mesa de Control)',
        type: 'INTEGRATION',
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `Odoo desvinculó la cotización de venta #${sale.id} (${titular})`,
      details: {
        kind: 'changes',
        before,
        after: saleToAuditSnapshot(sale),
        reason: trimmedReason,
        previousOdooSaleOrderId: previousOrderId,
      },
    });

    return {
      id: sale.id,
      odooSaleOrderId: sale.odooSaleOrderId,
      alreadyCleared: false,
    };
  }

  /** Asocia la cotización sale.order creada desde Mesa de Control. */
  async setOdooSaleOrder(
    id: number,
    odooSaleOrderId: number,
    contrato?: string,
  ) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (sale.status === SaleStatus.REJECTED) {
      throw new BadRequestException(
        'No se puede vincular cotización a una venta rechazada',
      );
    }
    if (!sale.odooPartnerId) {
      throw new BadRequestException(
        'La venta debe tener un cliente Odoo asociado',
      );
    }
    if (
      sale.odooSaleOrderId &&
      sale.odooSaleOrderId !== odooSaleOrderId
    ) {
      throw new ConflictException(
        `La venta ya está asociada a la cotización Odoo ${sale.odooSaleOrderId}`,
      );
    }
    sale.odooSaleOrderId = odooSaleOrderId;
    const quoteName = (contrato || '').trim();
    if (quoteName) {
      sale.contrato = quoteName;
    }
    this.applySignedStatus(sale);
    await this.salesRepository.saveWithoutDocuments(sale);
    if (quoteName) {
      await this.refreshContratoOnDriveDocuments(sale, quoteName);
    }
    return {
      id: sale.id,
      odooSaleOrderId: sale.odooSaleOrderId,
      contrato: sale.contrato,
      status: sale.status,
    };
  }

  /**
   * Tras generar cotización, el folio (`sale.order.name`) se sella en todos
   * los PDFs que muestran número de contrato (mismo archivo en Drive).
   */
  private async refreshContratoOnDriveDocuments(sale: Sale, contrato: string) {
    if (!this.googleDrive.isEnabled()) return;
    const folio = contrato.trim();
    if (!folio) return;

    const loaded = await this.salesRepository.findById(sale.id);
    const current = loaded ?? sale;

    const driveHint: Partial<Record<DocumentKind, string>> = {
      [DocumentKind.CARATULA]: `${current.id}-Caratula`,
      [DocumentKind.CARTA_EXCLUSIONES]: 'CartaAceptacionExclusiones',
      [DocumentKind.REGLAMENTO_PARQUE]: 'ReglamentoParque.pdf',
      [DocumentKind.REGLAMENTO_FOLLETO]: 'ReglamentoParqueFolleto',
      [DocumentKind.CARTA_AUTORIZACION]: 'CartaAutorizacion',
      [DocumentKind.CARTA_NOMINA]: 'CartaConsentimientoNomina',
      [DocumentKind.CARTA_FACTURA]: 'CartaRequerimientoFactura',
      [DocumentKind.CARTA_NO_FACTURA]: 'ConsentimientoNoFactura',
    };

    for (const [kind, stamp] of Object.entries(CONTRATO_STAMPS)) {
      const docKind = kind as DocumentKind;
      const existing = (current.documents ?? []).find((d) => d.kind === docKind);
      let fileId = existing?.driveFileId ?? null;
      if (!fileId && current.driveFolderId) {
        const hint = driveHint[docKind];
        const found = hint
          ? await this.googleDrive.findSalePdfInFolder(current.driveFolderId, hint)
          : null;
        fileId = found?.id ?? null;
        if (found && !existing) {
          const doc = new SaleDocument();
          doc.kind = docKind;
          doc.name = found.name;
          doc.mime = 'application/pdf';
          doc.driveFileId = found.id;
          doc.driveFileUrl = found.url;
          doc.dataBase64 = null;
          doc.saleId = sale.id;
          await this.salesRepository.saveDocument(doc);
        }
      }
      if (!fileId) {
        this.logger.warn(
          `Venta #${sale.id}: cotización ${contrato} sin ${docKind} en Drive; no se actualizó el folio`,
        );
        continue;
      }

      try {
        const downloaded = await this.googleDrive.downloadFileBase64(fileId);
        if (!downloaded?.dataBase64) {
          throw new Error(`No se pudo descargar ${docKind}`);
        }
        const stamped = stampTextOnPdf(
          Buffer.from(downloaded.dataBase64, 'base64'),
          folio,
          stamp,
        );
        await this.googleDrive.updateFileBuffer(
          fileId,
          'application/pdf',
          stamped,
        );
        this.logger.log(
          `Venta #${sale.id}: ${docKind} Drive actualizado con contrato ${contrato}`,
        );
      } catch (e) {
        this.logger.error(
          `Venta #${sale.id}: no se actualizó ${docKind} en Drive — ${(e as Error).message}`,
          (e as Error).stack,
        );
      }
    }
  }

  async createDraft(user: AuthUserPayload, dto: UpsertSaleDto) {
    await this.purgeExpired();
    const now = new Date();
    const { draftLimit, draftTtlHours } = await this.settingsService.getDraftPolicy();
    const count = await this.salesRepository.countActiveDrafts(
      user.userId,
      now,
      draftTtlHours,
    );
    if (count >= draftLimit) {
      throw new BadRequestException(
        `Solo puedes tener ${draftLimit} borradores. Elimina o envía uno antes de crear otro.`,
      );
    }

    if (dto.payload.contacto?.curp?.trim()) {
      try {
        assertValidCurp(dto.payload.contacto.curp);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }

    const seller = await this.usersRepository.findById(user.userId);
    const sale = this.salesRepository.create();
    sale.sellerId = user.userId;
    sale.sellerName = seller?.fullName ?? 'Vendedor';
    sale.status = SaleStatus.DRAFT;
    sale.amount = '0';
    sale.draftExpiresAt = await this.draftExpiry(now);
    applyPayloadToSale(sale, dto.payload);
    this.applySellerCatalogNames(sale, seller);
    await this.assertDiscountAndSaldo(sale, user.userId);
    if (dto.titularName?.trim()) sale.titularName = dto.titularName.trim();

    const saved = await this.salesRepository.save(sale);
    await this.syncFolioSolicitud(saved);
    const titular =
      saved.titularName || (saved.holder ? fullName(saved.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.CREATE,
      entityType: AuditEntityType.SALE,
      entityId: saved.id,
      summary: `Guardó borrador de venta #${saved.id} (${titular})`,
      details: { kind: 'sale', after: saleToAuditSnapshot(saved) },
    });

    return saleToPublic(saved);
  }

  async updateDraft(id: number, user: AuthUserPayload, dto: UpsertSaleDto) {
    await this.purgeExpired();
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
    if (sale.status !== SaleStatus.DRAFT) {
      throw new BadRequestException('Solo se pueden editar borradores');
    }
    if (sale.draftExpiresAt && sale.draftExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('El borrador ya expiró');
    }

    if (dto.payload.contacto?.curp?.trim()) {
      try {
        assertValidCurp(dto.payload.contacto.curp);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }

    const beforeDraft = saleToAuditSnapshot(sale);
    applyPayloadToSale(sale, dto.payload);
    const seller = await this.usersRepository.findById(user.userId);
    this.applySellerCatalogNames(sale, seller);
    await this.assertDiscountAndSaldo(sale, user.userId);
    if (dto.titularName?.trim()) sale.titularName = dto.titularName.trim();
    if (!sale.draftExpiresAt && sale.createdAt) {
      sale.draftExpiresAt = await this.draftExpiry(sale.createdAt);
    }
    sale.folioSolicitud = formatDigitalFolio(sale.id);
    const saved = await this.salesRepository.save(sale);
    const afterDraft = saleToAuditSnapshot(saved);
    const draftChanges = diffChanges(beforeDraft, afterDraft);
    if (Object.keys(draftChanges).length) {
      const titular =
        saved.titularName ||
        (saved.holder ? fullName(saved.holder) : '') ||
        'sin titular';
      await this.auditService.record({
        actor: {
          userId: user.userId,
          fullName: seller?.fullName,
          type: user.type,
        },
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.SALE,
        entityId: saved.id,
        summary: `Actualizó borrador de venta #${saved.id} (${titular})`,
        details: { kind: 'changes', changes: draftChanges },
      });
    }
    return saleToPublic(saved);
  }

  /** Finaliza captura → pendiente de pago (sin pago ni firma en el formulario). */
  async finalizeCapture(
    id: number | null,
    user: AuthUserPayload,
    dto: UpsertSaleDto,
  ) {
    await this.purgeExpired();
    this.validateCapture(dto.payload, true);

    const seller = await this.usersRepository.findById(user.userId);
    let sale: Sale;

    if (id != null) {
      const existing = await this.salesRepository.findById(id);
      if (!existing) throw new NotFoundException('Venta no encontrada');
      this.assertSellerOwns(existing, user.userId);
      if (existing.status !== SaleStatus.DRAFT) {
        throw new BadRequestException('Esta venta ya no es un borrador');
      }
      sale = existing;
    } else {
      sale = this.salesRepository.create();
      sale.sellerId = user.userId;
      sale.sellerName = seller?.fullName ?? 'Vendedor';
      sale.amount = '0';
    }

    applyPayloadToSale(sale, dto.payload);
    const tipoVenta = String(dto.payload?.meta?.tipoVenta || sale.estatus || '')
      .trim()
      .toUpperCase();
    const originSales = parseReconocimientoVentas(sale.reconocimientoVentas);
    if (
      (tipoVenta === 'RECONOCIMIENTO' ||
        tipoVenta === 'MEJORA' ||
        tipoVenta === 'MINORIA' ||
        sale.estatus === 'REACTIVACION' ||
        sale.estatus === 'MEJORA' ||
        sale.estatus === 'MINORIA') &&
      !originSales.length
    ) {
      throw new BadRequestException(
        tipoVenta === 'MEJORA' || sale.estatus === 'MEJORA'
          ? 'Selecciona al menos una venta a mejorar'
          : tipoVenta === 'MINORIA' || sale.estatus === 'MINORIA'
            ? 'Selecciona al menos una venta de minoría'
            : 'Selecciona al menos una venta a reconocer',
      );
    }
    this.applySellerCatalogNames(sale, seller);
    await this.assertDiscountAndSaldo(sale, user.userId);
    sale.status = SaleStatus.PENDING_PAYMENT;
    sale.draftExpiresAt = null;
    sale.titularName =
      dto.titularName?.trim() ||
      (sale.holder ? fullName(sale.holder) : sale.titularName);

    const saved = await this.salesRepository.save(sale);
    await this.syncFolioSolicitud(saved);

    try {
      await this.reservePreassignedSpace(saved);
    } catch (e) {
      saved.status = SaleStatus.DRAFT;
      saved.draftExpiresAt = await this.draftExpiry(saved.createdAt);
      await this.salesRepository.saveWithoutDocuments(saved);
      throw e;
    }

    const discountPct = this.parseMoney(saved.promocionDescuento);
    const globalMax = await this.settingsService.getGlobalMaxDiscount();
    const grantId = await this.discountsService.consumeForSale(
      user.userId,
      discountPct,
      globalMax,
      saved.id,
      user,
    );
    if (grantId != null) {
      saved.discountGrantId = grantId;
      await this.salesRepository.saveWithoutDocuments(saved);
    }

    const titular =
      saved.titularName || (saved.holder ? fullName(saved.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: id != null ? AuditAction.UPDATE : AuditAction.CREATE,
      entityType: AuditEntityType.SALE,
      entityId: saved.id,
      summary: `Generó venta nueva #${saved.id} (${titular})`,
      details: { kind: 'sale', after: saleToAuditSnapshot(saved) },
    });

    const odooSync = await this.syncReceptionToOdoo(saved.id);
    saved.odooReceptionSynced = odooSync.synced;
    return {
      ...saleToPublic(saved),
      odooSyncError: odooSync.error ?? null,
    };
  }

  /** Importe a cobrar: anticipo + pago inicial (si ambos existen). */
  private paymentDueAmount(sale: Sale): number {
    const anticipo = this.parseMoney(sale.anticipo);
    const inicial = this.parseMoney(sale.pagoInicial);
    return Number(((anticipo > 0 ? anticipo : 0) + (inicial > 0 ? inicial : 0)).toFixed(2));
  }

  private assertPaymentProof(sale: Sale, dto: SavePaymentDto, message: string) {
    const existing = (sale.documents ?? []).find(
      (d) => d.kind === DocumentKind.COMP_TRANSFERENCIA,
    );
    if (
      !dto.comprobanteTransferencia?.dataBase64 &&
      !existing?.dataBase64 &&
      !existing?.driveFileId
    ) {
      throw new BadRequestException(message);
    }
  }

  async savePayment(id: number, user: AuthUserPayload, dto: SavePaymentDto) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
    if (sale.status !== SaleStatus.PENDING_PAYMENT) {
      throw new BadRequestException(
        'Solo se puede registrar pago en ventas pendientes de pago',
      );
    }

    const p = dto.pago;

    // Financiamiento y domiciliación ya quedaron en captura; aquí solo este cobro.
    sale.formaPago = (p.formaPago ?? '').trim();
    sale.cuentaPago = (p.cuentaPago ?? '').trim();
    sale.bancoPago = (p.bancoPago ?? '').trim();

    const forma = sale.formaPago.toUpperCase();
    if (
      !['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'TARJETA DEBITO', 'TARJETA CREDITO'].includes(
        forma,
      )
    ) {
      throw new BadRequestException('Indica una forma de pago válida');
    }

    const dueNum = this.paymentDueAmount(sale);
    if (dueNum <= 0) {
      throw new BadRequestException(
        'La venta debe tener pago inicial o anticipo válido para registrar el pago',
      );
    }

    if (this.parseMoney(sale.precioPlan) <= 0) {
      throw new BadRequestException('Indica el precio del plan');
    }

    if (forma === 'EFECTIVO') {
      sale.cuentaPago = '';
      sale.bancoPago = '';
      sale.montoRecibido = (p.montoRecibido ?? '').trim();
      if (!sale.montoRecibido) {
        throw new BadRequestException('Indica el efectivo recibido');
      }
      const received = Number(
        String(sale.montoRecibido).replace(/[^0-9.-]/g, ''),
      );
      if (!Number.isFinite(received) || received <= 0) {
        throw new BadRequestException('El efectivo recibido no es válido');
      }
      if (received < dueNum) {
        throw new BadRequestException(
          'El efectivo recibido debe cubrir el anticipo y el pago inicial',
        );
      }
      sale.cambio = String(
        Number(Math.max(0, received - dueNum).toFixed(2)),
      );
      this.assertPaymentProof(sale, dto, 'Adjunta el comprobante de pago');
    } else {
      sale.montoRecibido = '';
      sale.cambio = '';
      if (!sale.bancoPago) {
        throw new BadRequestException('Indica el banco');
      }
      if (
        (forma === 'TRANSFERENCIA' ||
          forma === 'TARJETA DEBITO' ||
          forma === 'TARJETA CREDITO') &&
        !sale.cuentaPago
      ) {
        throw new BadRequestException(
          forma.startsWith('TARJETA')
            ? 'Indica la cuenta de la tarjeta'
            : 'Indica la cuenta de transferencia',
        );
      }
      if (forma === 'CHEQUE') {
        sale.cuentaPago = '';
      }
      if (forma === 'TRANSFERENCIA') {
        this.assertPaymentProof(
          sale,
          dto,
          'Adjunta el comprobante de transferencia',
        );
      }
    }

    this.recomputeSaldo(sale);
    const n = Number(String(sale.precioPlan).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) sale.amount = n.toFixed(2);

    // Asesor y jefe de ventas salen del catálogo del vendedor.
    const seller = await this.usersRepository.findById(user.userId);
    this.applySellerCatalogNames(sale, seller);
    if (!sale.nombreAsesor) {
      sale.nombreAsesor = sale.sellerName?.trim() || '';
    }

    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';

    let ticketPdfLink: string | null = null;
    if (dto.ticketPdf?.dataBase64) {
      const docs = (sale.documents ?? []).filter(
        (d) => d.kind !== DocumentKind.TICKET_PAGO,
      );
      const ticket = new SaleDocument();
      ticket.kind = DocumentKind.TICKET_PAGO;
      ticket.name = dto.ticketPdf.name || `${sale.id}-Ticket.pdf`;
      ticket.mime = dto.ticketPdf.mime || 'application/pdf';
      ticket.dataBase64 = dto.ticketPdf.dataBase64;
      ticket.driveFileId = null;
      ticket.driveFileUrl = null;
      if (this.googleDrive.isEnabled()) {
        try {
          const uploaded = await this.googleDrive.uploadSaleTicket({
            saleId: sale.id,
            titularName: titular,
            fecha: sale.fecha,
            existingFolderId: sale.driveFolderId,
            existingFolderPath: sale.driveFolderPath,
            existingFolderUrl: sale.driveFolderUrl,
            fileName: ticket.name,
            mime: ticket.mime,
            dataBase64: ticket.dataBase64,
          });
          if (uploaded) {
            ticket.driveFileId = uploaded.fileId;
            ticket.driveFileUrl = uploaded.fileUrl;
            ticket.name = uploaded.fileName || ticket.name;
            sale.driveFolderId = uploaded.folderId;
            sale.driveFolderUrl = uploaded.folderUrl;
            sale.driveFolderPath = uploaded.folderName;
            ticketPdfLink = uploaded.downloadUrl;
          }
        } catch (e) {
          this.logger.error(
            `Venta #${sale.id}: no se subió el ticket a Drive — ${(e as Error).message}`,
          );
        }
      } else {
        this.logger.warn(
          `Venta #${sale.id}: Drive no configurado; ticket sin URL pública`,
        );
      }
      docs.push(ticket);
      sale.documents = docs;
    }

    if (dto.comprobanteTransferencia?.dataBase64) {
      const docs = (sale.documents ?? []).filter(
        (d) => d.kind !== DocumentKind.COMP_TRANSFERENCIA,
      );
      const transfer = new SaleDocument();
      transfer.kind = DocumentKind.COMP_TRANSFERENCIA;
      transfer.name =
        dto.comprobanteTransferencia.name ||
        `comprobante-transferencia_${sale.id}`;
      transfer.mime =
        dto.comprobanteTransferencia.mime || 'application/octet-stream';
      transfer.dataBase64 = dto.comprobanteTransferencia.dataBase64;
      transfer.driveFileId = null;
      transfer.driveFileUrl = null;
      docs.push(transfer);
      sale.documents = docs;
    }

    sale.status = SaleStatus.PENDING_SIGNATURE;
    await this.salesRepository.save(sale);

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `Generó pago de venta #${sale.id} (${titular})`,
      details: {
        kind: 'payment',
        formaPago: sale.formaPago,
        montoRecibido: sale.montoRecibido,
        cambio: sale.cambio,
        anticipo: sale.anticipo,
        pagoInicial: sale.pagoInicial,
        frecuencia: sale.frecuencia,
        banco: sale.bancoPago || sale.banco,
        cuenta: sale.cuentaPago || sale.cuenta,
        amount: Number(sale.amount) || 0,
        status: sale.status,
      },
    });

    const odooSync = await this.syncReceptionToOdoo(sale.id);
    sale.odooReceptionSynced = odooSync.synced;

    try {
      await this.ticketNotifications.sendPaymentTicket({
        customerName: titular,
        amount: dueNum,
        phone: sale.holder?.celular1,
        email: sale.holder?.correo,
        pdfLink: ticketPdfLink,
      });
    } catch (e) {
      this.logger.error(
        `Venta #${sale.id}: no se envió el ticket por SMS/WhatsApp/correo — ${(e as Error).message}`,
      );
    }

    return {
      ...saleToPublic(sale),
      odooSyncError: odooSync.error ?? null,
    };
  }

  /** Envía solo el enlace de firma al correo del titular. No incluye el ticket. */
  async sendClientSignLink(
    id: number,
    user: AuthUserPayload,
    frontCandidates?: Array<string | undefined>,
  ) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
    if (sale.status !== SaleStatus.PENDING_SIGNATURE) {
      throw new BadRequestException(
        'Solo se puede enviar el enlace cuando la venta está pendiente de firma',
      );
    }

    const email = (sale.holder?.correo || '').trim();
    if (!email) {
      throw new BadRequestException(
        'El titular no tiene correo para enviar el enlace de firma',
      );
    }

    const titular =
      sale.titularName ||
      (sale.holder ? fullName(sale.holder) : '') ||
      'Cliente';
    await this.ticketNotifications.sendSignLink({
      customerName: titular,
      email,
      signUrl: this.clientSignUrl(sale.id, frontCandidates),
    });

    const seller = await this.usersRepository.findById(user.userId);
    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `Envió correo de firma al titular de venta #${sale.id} (${titular})`,
      details: { kind: 'email', correo: email },
    });

    return { ok: true };
  }

  private clientSignToken(saleId: number): string {
    return this.jwt.sign(
      { purpose: 'client-sign', saleId },
      { expiresIn: '30d' },
    );
  }

  private parseClientSignToken(raw: string): number {
    const token = decodeURIComponent(String(raw || '').trim());
    if (!token) {
      throw new NotFoundException('Enlace de firma inválido o vencido');
    }
    try {
      const payload = this.jwt.verify<{ purpose?: string; saleId?: number }>(
        token,
      );
      const saleId = Number(payload?.saleId);
      if (payload?.purpose !== 'client-sign' || !Number.isInteger(saleId) || saleId < 1) {
        throw new Error('bad payload');
      }
      return saleId;
    } catch {
      throw new NotFoundException('Enlace de firma inválido o vencido');
    }
  }

  /** Origen http(s) de una URL o de un header Origin/Referer. */
  private frontOrigin(raw?: string): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      if (url.username || url.password) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  private resolveFrontBase(candidates?: Array<string | undefined>): string {
    for (const raw of candidates ?? []) {
      const origin = this.frontOrigin(raw);
      if (origin) return origin;
    }

    if (this.config.get<string>('NODE_ENV') !== 'production') {
      return 'http://localhost:5173';
    }

    throw new BadRequestException(
      'No se pudo armar el enlace de firma: falta la URL del front.',
    );
  }

  private clientSignUrl(
    saleId: number,
    frontCandidates?: Array<string | undefined>,
  ): string {
    const front = this.resolveFrontBase(frontCandidates);
    return `${front}/firmar/${encodeURIComponent(this.clientSignToken(saleId))}`;
  }

  async getForClientSign(token: string) {
    const id = this.parseClientSignToken(token);
    const sale = await this.salesRepository.findByIdWithFiles(id);
    if (!sale) throw new NotFoundException('Enlace de firma inválido o vencido');
    if (
      sale.status === SaleStatus.COMPLETED ||
      sale.status === SaleStatus.PENDING_VALIDATION
    ) {
      return { ...saleToListItem(sale), alreadySigned: true, payload: {} };
    }
    if (sale.status !== SaleStatus.PENDING_SIGNATURE) {
      throw new BadRequestException(
        'Esta venta aún no está lista para firmar. Espera el registro del pago.',
      );
    }
    return { ...saleToPublic(sale), alreadySigned: false };
  }

  async signSaleByClientToken(token: string, dto: SignSaleDto) {
    const id = this.parseClientSignToken(token);
    return this.signSale(id, null, dto, true);
  }

  async signSale(
    id: number,
    user: AuthUserPayload | null,
    dto: SignSaleDto,
    viaClientLink = false,
  ) {
    const sale = await this.salesRepository.findByIdWithFiles(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (user) this.assertSellerOwns(sale, user.userId);
    if (
      sale.status === SaleStatus.COMPLETED ||
      sale.status === SaleStatus.PENDING_VALIDATION
    ) {
      return {
        ...saleToPublic(sale),
        odooSyncError: null,
      };
    }
    if (sale.status !== SaleStatus.PENDING_SIGNATURE) {
      throw new BadRequestException(
        'Solo se puede firmar cuando el pago ya fue registrado',
      );
    }
    const beforeStatus = sale.status;
    if (!dto.firmaCliente?.dataBase64) {
      throw new BadRequestException('La firma es obligatoria');
    }

    const docs = (sale.documents ?? []).filter((d) => d.kind !== DocumentKind.FIRMA);
    const firma = new SaleDocument();
    firma.kind = DocumentKind.FIRMA;
    firma.name = dto.firmaCliente.name || 'firma-cliente.png';
    firma.mime = dto.firmaCliente.mime || 'image/png';
    firma.dataBase64 = dto.firmaCliente.dataBase64;
    firma.driveFileId = null;
    firma.driveFileUrl = null;
    docs.push(firma);

    if (dto.caratulaPdf?.dataBase64) {
      const prevCaratula = docs.find((d) => d.kind === DocumentKind.CARATULA);
      const caratula = prevCaratula ?? new SaleDocument();
      caratula.kind = DocumentKind.CARATULA;
      caratula.name = dto.caratulaPdf.name || `${sale.id}-Caratula.pdf`;
      caratula.mime = dto.caratulaPdf.mime || 'application/pdf';
      caratula.dataBase64 = dto.caratulaPdf.dataBase64;
      caratula.driveFileId = null;
      caratula.driveFileUrl = null;
      if (!prevCaratula) docs.push(caratula);
    }

    if (dto.cartaFacturaPdf?.dataBase64) {
      const prevCarta = docs.find((d) => d.kind === DocumentKind.CARTA_FACTURA);
      const carta = prevCarta ?? new SaleDocument();
      carta.kind = DocumentKind.CARTA_FACTURA;
      carta.name =
        dto.cartaFacturaPdf.name || `${sale.id}-CartaRequerimientoFactura.pdf`;
      carta.mime = dto.cartaFacturaPdf.mime || 'application/pdf';
      carta.dataBase64 = dto.cartaFacturaPdf.dataBase64;
      carta.driveFileId = null;
      carta.driveFileUrl = null;
      if (!prevCarta) docs.push(carta);
    }

    if (dto.cartaNoFacturaPdf?.dataBase64) {
      const prevNoFactura = docs.find(
        (d) => d.kind === DocumentKind.CARTA_NO_FACTURA,
      );
      const noFactura = prevNoFactura ?? new SaleDocument();
      noFactura.kind = DocumentKind.CARTA_NO_FACTURA;
      noFactura.name =
        dto.cartaNoFacturaPdf.name || `${sale.id}-ConsentimientoNoFactura.pdf`;
      noFactura.mime = dto.cartaNoFacturaPdf.mime || 'application/pdf';
      noFactura.dataBase64 = dto.cartaNoFacturaPdf.dataBase64;
      noFactura.driveFileId = null;
      noFactura.driveFileUrl = null;
      if (!prevNoFactura) docs.push(noFactura);
    }

    if (dto.cartaExclusionesPdf?.dataBase64) {
      const prevExcl = docs.find(
        (d) => d.kind === DocumentKind.CARTA_EXCLUSIONES,
      );
      const exclusiones = prevExcl ?? new SaleDocument();
      exclusiones.kind = DocumentKind.CARTA_EXCLUSIONES;
      exclusiones.name =
        dto.cartaExclusionesPdf.name ||
        `${sale.id}-CartaAceptacionExclusiones.pdf`;
      exclusiones.mime = dto.cartaExclusionesPdf.mime || 'application/pdf';
      exclusiones.dataBase64 = dto.cartaExclusionesPdf.dataBase64;
      exclusiones.driveFileId = null;
      exclusiones.driveFileUrl = null;
      if (!prevExcl) docs.push(exclusiones);
    }

    if (dto.reglamentoParquePdf?.dataBase64) {
      const prevReglamento = docs.find(
        (d) => d.kind === DocumentKind.REGLAMENTO_PARQUE,
      );
      const reglamento = prevReglamento ?? new SaleDocument();
      reglamento.kind = DocumentKind.REGLAMENTO_PARQUE;
      reglamento.name =
        dto.reglamentoParquePdf.name || `${sale.id}-ReglamentoParque.pdf`;
      reglamento.mime = dto.reglamentoParquePdf.mime || 'application/pdf';
      reglamento.dataBase64 = dto.reglamentoParquePdf.dataBase64;
      reglamento.driveFileId = null;
      reglamento.driveFileUrl = null;
      if (!prevReglamento) docs.push(reglamento);
    }

    if (dto.reglamentoParqueFolletoPdf?.dataBase64) {
      const prevFolleto = docs.find(
        (d) => d.kind === DocumentKind.REGLAMENTO_FOLLETO,
      );
      const folleto = prevFolleto ?? new SaleDocument();
      folleto.kind = DocumentKind.REGLAMENTO_FOLLETO;
      folleto.name =
        dto.reglamentoParqueFolletoPdf.name ||
        `${sale.id}-ReglamentoParqueFolleto.pdf`;
      folleto.mime = dto.reglamentoParqueFolletoPdf.mime || 'application/pdf';
      folleto.dataBase64 = dto.reglamentoParqueFolletoPdf.dataBase64;
      folleto.driveFileId = null;
      folleto.driveFileUrl = null;
      if (!prevFolleto) docs.push(folleto);
    }

    if (dto.cartaAutorizacionPdf?.dataBase64) {
      const prevAuth = docs.find((d) => d.kind === DocumentKind.CARTA_AUTORIZACION);
      const authDoc = prevAuth ?? new SaleDocument();
      authDoc.kind = DocumentKind.CARTA_AUTORIZACION;
      authDoc.name =
        dto.cartaAutorizacionPdf.name ||
        `${sale.id}-CartaAutorizacionCargoAutomatico.pdf`;
      authDoc.mime = dto.cartaAutorizacionPdf.mime || 'application/pdf';
      authDoc.dataBase64 = dto.cartaAutorizacionPdf.dataBase64;
      authDoc.driveFileId = null;
      authDoc.driveFileUrl = null;
      if (!prevAuth) docs.push(authDoc);
    }

    if (dto.cartaNominaPdf?.dataBase64) {
      const prevNomina = docs.find((d) => d.kind === DocumentKind.CARTA_NOMINA);
      const nominaDoc = prevNomina ?? new SaleDocument();
      nominaDoc.kind = DocumentKind.CARTA_NOMINA;
      nominaDoc.name =
        dto.cartaNominaPdf.name ||
        `${sale.id}-CartaConsentimientoNomina.pdf`;
      nominaDoc.mime = dto.cartaNominaPdf.mime || 'application/pdf';
      nominaDoc.dataBase64 = dto.cartaNominaPdf.dataBase64;
      nominaDoc.driveFileId = null;
      nominaDoc.driveFileUrl = null;
      if (!prevNomina) docs.push(nominaDoc);
    }

    if (dto.tarjetaPdf?.dataBase64) {
      const prevCard = docs.find((d) => d.kind === DocumentKind.TARJETA);
      const cardDoc = prevCard ?? new SaleDocument();
      cardDoc.kind = DocumentKind.TARJETA;
      cardDoc.name =
        dto.tarjetaPdf.name || `${sale.id}-TarjetaAmbosLados.pdf`;
      cardDoc.mime = dto.tarjetaPdf.mime || 'application/pdf';
      cardDoc.dataBase64 = dto.tarjetaPdf.dataBase64;
      cardDoc.driveFileId = null;
      cardDoc.driveFileUrl = null;
      if (!prevCard) docs.push(cardDoc);
    }

    if (dto.inePdf?.dataBase64) {
      const prevIne = docs.find((d) => d.kind === DocumentKind.INE);
      const ineDoc = prevIne ?? new SaleDocument();
      ineDoc.kind = DocumentKind.INE;
      ineDoc.name = dto.inePdf.name || `${sale.id}-INE-AmbosLados.pdf`;
      ineDoc.mime = dto.inePdf.mime || 'application/pdf';
      ineDoc.dataBase64 = dto.inePdf.dataBase64;
      ineDoc.driveFileId = null;
      ineDoc.driveFileUrl = null;
      if (!prevIne) docs.push(ineDoc);
    }

    const docAtt = (kind: DocumentKind) => {
      const d = docs.find((x) => x.kind === kind);
      if (!d?.dataBase64) return null;
      return { name: d.name, mime: d.mime, dataBase64: d.dataBase64 };
    };
    const documentosPayload: Record<string, unknown> = {
      ineFrente: docAtt(DocumentKind.INE_FRENTE),
      ineReverso: docAtt(DocumentKind.INE_REVERSO),
      comprobanteDomicilio: docAtt(DocumentKind.COMPROBANTE),
      constanciaSituacionFiscal: docAtt(DocumentKind.CONSTANCIA_FISCAL),
      tarjetaFrente: docAtt(DocumentKind.TARJETA_FRENTE),
      tarjetaReverso: docAtt(DocumentKind.TARJETA_REVERSO),
      tarjetaPdf: docAtt(DocumentKind.TARJETA),
      reciboNomina: docAtt(DocumentKind.RECIBO_NOMINA),
      domiciliacionBanorte: docAtt(DocumentKind.BANORTE_DOM),
      ticketPago: docs.find((d) => d.kind === DocumentKind.TICKET_PAGO)
        ?.driveFileId
        ? null
        : docAtt(DocumentKind.TICKET_PAGO),
      comprobanteTransferencia: docAtt(DocumentKind.COMP_TRANSFERENCIA),
      firmaCliente: dto.firmaCliente,
    };

    const driveKeyToKind: Record<string, DocumentKind> = {
      comprobanteDomicilio: DocumentKind.COMPROBANTE,
      constanciaSituacionFiscal: DocumentKind.CONSTANCIA_FISCAL,
      ticketPago: DocumentKind.TICKET_PAGO,
      comprobanteTransferencia: DocumentKind.COMP_TRANSFERENCIA,
      firmaCliente: DocumentKind.FIRMA,
      caratulaPdf: DocumentKind.CARATULA,
      cartaFacturaPdf: DocumentKind.CARTA_FACTURA,
      cartaNoFacturaPdf: DocumentKind.CARTA_NO_FACTURA,
      cartaExclusionesPdf: DocumentKind.CARTA_EXCLUSIONES,
      reglamentoParquePdf: DocumentKind.REGLAMENTO_PARQUE,
      reglamentoParqueFolletoPdf: DocumentKind.REGLAMENTO_FOLLETO,
      cartaAutorizacionPdf: DocumentKind.CARTA_AUTORIZACION,
      cartaNominaPdf: DocumentKind.CARTA_NOMINA,
      reciboNomina: DocumentKind.RECIBO_NOMINA,
      domiciliacionBanorte: DocumentKind.BANORTE_DOM,
      tarjetaPdf: DocumentKind.TARJETA,
      inePdf: DocumentKind.INE,
      ineFrente: DocumentKind.INE_FRENTE,
      ineReverso: DocumentKind.INE_REVERSO,
      tarjetaFrente: DocumentKind.TARJETA_FRENTE,
      tarjetaReverso: DocumentKind.TARJETA_REVERSO,
    };

    if (this.googleDrive.isEnabled()) {
      this.logger.log(`Firma venta #${sale.id}: subiendo documentos a Drive`);
      try {
        const driveInfo = await this.googleDrive.uploadSaleDocuments({
          saleId: sale.id,
          titularName: sale.titularName,
          fecha: sale.fecha,
          documentos: documentosPayload,
          caratulaPdf: dto.caratulaPdf ?? null,
          cartaFacturaPdf: dto.cartaFacturaPdf ?? null,
          cartaNoFacturaPdf: dto.cartaNoFacturaPdf ?? null,
          cartaExclusionesPdf: dto.cartaExclusionesPdf ?? null,
          reglamentoParquePdf: dto.reglamentoParquePdf ?? null,
          reglamentoParqueFolletoPdf: dto.reglamentoParqueFolletoPdf ?? null,
          cartaAutorizacionPdf: dto.cartaAutorizacionPdf ?? null,
          cartaNominaPdf: dto.cartaNominaPdf ?? null,
          tarjetaPdf: dto.tarjetaPdf ?? docAtt(DocumentKind.TARJETA),
          inePdf: dto.inePdf ?? docAtt(DocumentKind.INE),
        });
        if (!driveInfo) {
          throw new Error('Drive no devolvió carpeta de venta');
        }

        for (const file of driveInfo.files) {
          const kind = driveKeyToKind[file.key];
          if (!kind) continue;
          let doc = docs.find((d) => d.kind === kind);
          if (!doc) {
            doc = new SaleDocument();
            doc.kind = kind;
            doc.name = file.name;
            doc.mime =
              kind === DocumentKind.CARATULA ||
              kind === DocumentKind.CARTA_FACTURA ||
              kind === DocumentKind.CARTA_NO_FACTURA ||
              kind === DocumentKind.CARTA_EXCLUSIONES ||
              kind === DocumentKind.REGLAMENTO_PARQUE ||
              kind === DocumentKind.REGLAMENTO_FOLLETO ||
              kind === DocumentKind.CARTA_AUTORIZACION ||
              kind === DocumentKind.CARTA_NOMINA ||
              kind === DocumentKind.TARJETA ||
              kind === DocumentKind.INE
                ? 'application/pdf'
                : 'application/octet-stream';
            docs.push(doc);
          }
          doc.name = file.name;
          doc.driveFileId = file.id;
          doc.driveFileUrl = file.url;
          // Firma y ticket se conservan en BD (pesos bajos) para vista previa PDF.
          // INE / comprobante / carátula sí se limpian tras subir a Drive.
          if (
            kind !== DocumentKind.FIRMA &&
            kind !== DocumentKind.TICKET_PAGO
          ) {
            doc.dataBase64 = null;
          }
        }

        for (const side of [
          DocumentKind.TARJETA_FRENTE,
          DocumentKind.TARJETA_REVERSO,
          DocumentKind.INE_FRENTE,
          DocumentKind.INE_REVERSO,
        ]) {
          const sideDoc = docs.find((d) => d.kind === side);
          if (sideDoc) sideDoc.dataBase64 = null;
        }

        sale.documents = docs;
        sale.driveFolderId = driveInfo.folderId;
        sale.driveFolderUrl = driveInfo.folderUrl;
        sale.driveFolderPath = driveInfo.folderName;
        sale.status = this.signedStatusFor(sale);
        await this.salesRepository.save(sale);
        this.logger.log(
          `Firma venta #${sale.id}: Drive OK (${driveInfo.files.length} archivos)`,
        );
      } catch (e) {
        this.logger.error(
          `Drive venta #${sale.id}: ${(e as Error).message}`,
          (e as Error).stack,
        );
        throw new BadRequestException(
          `No se pudo subir a Drive: ${(e as Error).message}. Intenta firmar de nuevo.`,
        );
      }
    } else {
      // Sin Drive: se conserva base64 (entorno local / no configurado)
      sale.documents = docs;
      sale.status = this.signedStatusFor(sale);
      await this.salesRepository.save(sale);
    }

    const seller = user
      ? await this.usersRepository.findById(user.userId)
      : await this.usersRepository.findById(sale.sellerId);
    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';
    const actorName = viaClientLink
      ? titular
      : seller?.fullName ?? 'Vendedor';

    await this.auditService.record({
      actor: {
        userId: viaClientLink ? null : user?.userId ?? sale.sellerId,
        fullName: actorName,
        type: viaClientLink ? 'CLIENTE' : user?.type,
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: viaClientLink
        ? `El titular firmó venta #${sale.id} (${titular}) desde el enlace del correo`
        : `Firmó venta #${sale.id} (${titular})`,
      details: {
        kind: 'sign',
        changes: {
          status: { from: beforeStatus, to: sale.status },
        },
      },
    });

    void this.syncReceptionToOdoo(sale.id).then((odooSync) => {
      sale.odooReceptionSynced = odooSync.synced;
    });
    return {
      ...saleToPublic(sale),
      odooSyncError: null,
    };
  }

  async deleteDraft(id: number, user: AuthUserPayload) {
    const sale = await this.salesRepository.findById(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
    if (sale.status !== SaleStatus.DRAFT) {
      throw new BadRequestException('Solo se pueden eliminar borradores');
    }

    const seller = await this.usersRepository.findById(user.userId);
    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';
    const snapshot = saleToAuditSnapshot(sale);

    await this.salesRepository.deleteById(id);

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.DELETE,
      entityType: AuditEntityType.SALE,
      entityId: id,
      summary: `Eliminó borrador de venta #${id} (${titular})`,
      details: { kind: 'delete', after: snapshot },
    });

    return { ok: true };
  }

  /** Compat: alias antiguo submit → finalizeCapture */
  async submit(id: number | null, user: AuthUserPayload, dto: UpsertSaleDto) {
    return this.finalizeCapture(id, user, dto);
  }
}
