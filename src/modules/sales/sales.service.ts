import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SalesRepository } from './repositories/sales.repository';
import { SaleStatus } from './enums/sale-status.enum';
import { DocumentKind } from './enums/document-kind.enum';
import { UsersRepository } from '../users/repositories/users.repository';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/enums/audit-action.enum';
import { AuditEntityType } from '../audit/enums/audit-entity-type.enum';
import { Sale } from './entities/sale.entity';
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
  recognizedFromVentas,
  saleToAuditSnapshot,
  saleToPayload,
  saleToPublic,
  saleToListItem,
} from './mappers/sale.mapper';
import { assertValidCurp } from './utils/curp';
import { assertMxPhone } from './utils/phone';
import { SaleDocument } from './entities/sale-document.entity';
import { SettingsService } from '../settings/settings.service';
import { DiscountsService } from '../discounts/discounts.service';
import { OdooGsmClient, type OdooVdReceptionLink } from '../odoo/odoo-gsm.client';
import { PlanKind } from './enums/plan-kind.enum';
import { CONTRATO_STAMPS, stampTextOnPdf } from './utils/stamp-caratula-contrato';
import { formatDigitalFolio } from './utils/digital-folio';

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly salesRepository: SalesRepository,
    private readonly usersRepository: UsersRepository,
    private readonly auditService: AuditService,
    private readonly googleDrive: GoogleDriveService,
    private readonly settingsService: SettingsService,
    private readonly discountsService: DiscountsService,
    private readonly odooGsm: OdooGsmClient,
    private readonly ticketNotifications: TicketNotificationService,
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
      await this.ensureCaratulaFromDrive(sale);
      await this.hydrateAllDocuments(sale);
      const payload = saleToPublic(sale);
      await this.odooGsm.syncVdReception(payload as unknown as Record<string, unknown>);
      sale.odooReceptionSynced = true;
      await this.salesRepository.saveWithoutDocuments(sale);
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
    await this.salesRepository.deleteExpiredDrafts(new Date());
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

    const bens = payload.beneficiarios ?? [];
    const first = bens[0];
    if (!first || (!first.nombres?.trim() && !first.apellidoPaterno?.trim())) {
      throw new BadRequestException('Debes capturar al menos un beneficiario');
    }
    if (bens.length > 2) {
      throw new BadRequestException('Solo puedes agregar hasta 2 beneficiarios');
    }

    const branchId = Number(payload.meta?.branchId);
    if (!Number.isFinite(branchId) || branchId <= 0) {
      throw new BadRequestException('La sucursal es obligatoria');
    }
    const serviceTypeId = Number(payload.meta?.serviceTypeId);
    if (!Number.isFinite(serviceTypeId) || serviceTypeId <= 0) {
      throw new BadRequestException('El tipo de servicio es obligatorio');
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
      if (!hasIne || !payload.documentos?.comprobanteDomicilio) {
        throw new BadRequestException(
          'Debes adjuntar INE (frente y reverso) y comprobante de domicilio',
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
    const now = Date.now();
    const visible = items.filter((s) => {
      if (s.status === SaleStatus.DRAFT) {
        return !s.draftExpiresAt || s.draftExpiresAt.getTime() > now;
      }
      return true;
    });
    const drafts = visible.filter((s) => s.status === SaleStatus.DRAFT);
    const pipeline = visible.filter((s) => s.status !== SaleStatus.DRAFT);
    const { draftLimit, draftTtlHours } =
      await this.settingsService.getDraftPolicy();

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
      summary: `Odoo desvinculó cotización de venta #${sale.id} (${titular})`,
      details: {
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

    const driveHint: Partial<Record<DocumentKind, string>> = {
      [DocumentKind.CARATULA]: `${sale.id}-Caratula`,
      [DocumentKind.CARTA_EXCLUSIONES]: 'CartaAceptacionExclusiones',
      [DocumentKind.REGLAMENTO_PARQUE]: 'ReglamentoParque.pdf',
      [DocumentKind.REGLAMENTO_FOLLETO]: 'ReglamentoParqueFolleto',
      [DocumentKind.CARTA_AUTORIZACION]: 'CartaAutorizacion',
      [DocumentKind.CARTA_NOMINA]: 'CartaConsentimientoNomina',
    };

    for (const [kind, stamp] of Object.entries(CONTRATO_STAMPS)) {
      const docKind = kind as DocumentKind;
      const existing = (sale.documents ?? []).find((d) => d.kind === docKind);
      let fileId = existing?.driveFileId ?? null;
      if (!fileId && sale.driveFolderId) {
        const hint = driveHint[docKind];
        const found = hint
          ? await this.googleDrive.findSalePdfInFolder(sale.driveFolderId, hint)
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
          contrato,
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
    const { draftLimit } = await this.settingsService.getDraftPolicy();
    const count = await this.salesRepository.countActiveDrafts(user.userId, now);
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
      summary: `${seller?.fullName ?? 'Vendedor'} guardó borrador de venta #${saved.id} (${titular})`,
      details: { after: saleToAuditSnapshot(saved) },
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

    applyPayloadToSale(sale, dto.payload);
    const seller = await this.usersRepository.findById(user.userId);
    this.applySellerCatalogNames(sale, seller);
    await this.assertDiscountAndSaldo(sale, user.userId);
    if (dto.titularName?.trim()) sale.titularName = dto.titularName.trim();
    sale.draftExpiresAt = await this.draftExpiry();
    sale.folioSolicitud = formatDigitalFolio(sale.id);
    const saved = await this.salesRepository.save(sale);
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
      const { draftLimit } = await this.settingsService.getDraftPolicy();
      const count = await this.salesRepository.countActiveDrafts(
        user.userId,
        new Date(),
      );
      if (count >= draftLimit) {
        throw new BadRequestException(
          `Solo puedes tener ${draftLimit} borradores activos`,
        );
      }
      sale = this.salesRepository.create();
      sale.sellerId = user.userId;
      sale.sellerName = seller?.fullName ?? 'Vendedor';
      sale.amount = '0';
    }

    applyPayloadToSale(sale, dto.payload);
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
      saved.draftExpiresAt = await this.draftExpiry();
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
      summary: `${seller?.fullName ?? 'Vendedor'} finalizó captura de venta #${saved.id} (${titular})`,
      details: { after: saleToAuditSnapshot(saved) },
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
        const existing = (sale.documents ?? []).find(
          (d) => d.kind === DocumentKind.COMP_TRANSFERENCIA,
        );
        if (!dto.comprobanteTransferencia?.dataBase64 && !existing?.dataBase64 && !existing?.driveFileId) {
          throw new BadRequestException(
            'Adjunta el comprobante de transferencia',
          );
        }
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

    if (dto.ticketPdf?.dataBase64) {
      const docs = (sale.documents ?? []).filter(
        (d) => d.kind !== DocumentKind.TICKET_PAGO,
      );
      const ticket = new SaleDocument();
      ticket.kind = DocumentKind.TICKET_PAGO;
      ticket.name = dto.ticketPdf.name || `ticket-pago_${sale.id}.pdf`;
      ticket.mime = dto.ticketPdf.mime || 'application/pdf';
      ticket.dataBase64 = dto.ticketPdf.dataBase64;
      ticket.driveFileId = null;
      ticket.driveFileUrl = null;
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

    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `${seller?.fullName ?? 'Vendedor'} registró pago de venta #${sale.id} (${titular})`,
      details: { after: saleToAuditSnapshot(sale) },
    });

    const odooSync = await this.syncReceptionToOdoo(sale.id);
    sale.odooReceptionSynced = odooSync.synced;

    try {
      await this.ticketNotifications.sendPaymentTicket({
        customerName: titular,
        amount: dueNum,
        phone: sale.holder?.celular1,
        email: sale.holder?.correo,
        pdfBase64: dto.ticketPdf?.dataBase64,
        pdfName: dto.ticketPdf?.name || `${sale.id}-TicketPago.pdf`,
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

  async signSale(id: number, user: AuthUserPayload, dto: SignSaleDto) {
    const sale = await this.salesRepository.findByIdWithFiles(id);
    if (!sale) throw new NotFoundException('Venta no encontrada');
    this.assertSellerOwns(sale, user.userId);
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
      comprobanteDomicilio: docAtt(DocumentKind.COMPROBANTE),
      constanciaSituacionFiscal: docAtt(DocumentKind.CONSTANCIA_FISCAL),
      tarjetaFrente: docAtt(DocumentKind.TARJETA_FRENTE),
      tarjetaReverso: docAtt(DocumentKind.TARJETA_REVERSO),
      tarjetaPdf: docAtt(DocumentKind.TARJETA),
      reciboNomina: docAtt(DocumentKind.RECIBO_NOMINA),
      domiciliacionBanorte: docAtt(DocumentKind.BANORTE_DOM),
      ticketPago: docAtt(DocumentKind.TICKET_PAGO),
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

    const seller = await this.usersRepository.findById(user.userId);
    const titular =
      sale.titularName || (sale.holder ? fullName(sale.holder) : '') || 'sin titular';

    await this.auditService.record({
      actor: {
        userId: user.userId,
        fullName: seller?.fullName,
        type: user.type,
      },
      action: AuditAction.UPDATE,
      entityType: AuditEntityType.SALE,
      entityId: sale.id,
      summary: `${seller?.fullName ?? 'Vendedor'} firmó venta #${sale.id} (${titular})`,
      details: { after: saleToAuditSnapshot(sale) },
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
      summary: `${seller?.fullName ?? 'Vendedor'} eliminó borrador de venta #${id} (${titular})`,
      details: { after: snapshot },
    });

    return { ok: true };
  }

  /** Compat: alias antiguo submit → finalizeCapture */
  async submit(id: number | null, user: AuthUserPayload, dto: UpsertSaleDto) {
    return this.finalizeCapture(id, user, dto);
  }
}
