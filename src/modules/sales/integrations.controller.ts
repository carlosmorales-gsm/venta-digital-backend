import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { SetOdooPartnerDto } from './dto/set-odoo-partner.dto';
import { SetOdooSaleOrderDto } from './dto/set-odoo-sale-order.dto';
import { OdooRejectSaleDto } from './dto/odoo-reject-sale.dto';
import { OdooCorrectionDto } from './dto/odoo-correction.dto';
import { OdooClearSaleOrderDto } from './dto/odoo-clear-sale-order.dto';
import { SalesService } from './sales.service';

/**
 * Integraciones externas (Odoo Mesa de Control).
 * Auth: header `X-Api-Key` = ODOO_API_KEY del .env
 */
@Controller('integrations/odoo')
@UseGuards(ApiKeyGuard)
export class IntegrationsController {
  constructor(private readonly salesService: SalesService) {}

  /** Listado liviano para integraciones Odoo (legacy). */
  @Get('sales')
  conciliationSales() {
    return this.salesService.listForConciliation();
  }

  /** Detalle completo (captura + adjuntos) al abrir una venta en Odoo. */
  @Get('sales/:id')
  conciliationSaleDetail(@Param('id', ParseIntPipe) id: number) {
    return this.salesService.getOneForOdoo(id);
  }

  /** Guarda el id de res.partner asociado desde Odoo. */
  @Patch('sales/:id/partner')
  setPartner(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetOdooPartnerDto,
  ) {
    return this.salesService.setOdooPartner(id, dto.odooPartnerId);
  }

  /** Guarda el id de la cotización sale.order creada desde Odoo. */
  @Patch('sales/:id/sale-order')
  setSaleOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetOdooSaleOrderDto,
  ) {
    return this.salesService.setOdooSaleOrder(
      id,
      dto.odooSaleOrderId,
      dto.contrato,
    );
  }

  /**
   * Cancela / rechaza la venta en Venta Digital (estatus REJECTED).
   */
  @Patch('sales/:id/reject')
  rejectSale(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OdooRejectSaleDto,
  ) {
    return this.salesService.rejectFromOdoo(id, dto.reason);
  }

  /** Marca campos o documentos para que el vendedor los corrija. */
  @Patch('sales/:id/correction')
  requestCorrection(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OdooCorrectionDto,
  ) {
    return this.salesService.requestCorrectionFromOdoo(id, dto.fields);
  }

  /** Corrección reenviada por el vendedor, pendiente de aceptar o rechazar. */
  @Get('sales/:id/correction-review')
  correctionReview(@Param('id', ParseIntPipe) id: number) {
    return this.salesService.getCorrectionReview(id);
  }

  @Patch('sales/:id/correction-review/accept')
  acceptCorrectionReview(@Param('id', ParseIntPipe) id: number) {
    return this.salesService.acceptCorrectionReview(id);
  }

  @Patch('sales/:id/correction-review/reject')
  rejectCorrectionReview(@Param('id', ParseIntPipe) id: number) {
    return this.salesService.rejectCorrectionReview(id);
  }

  /** Desvincula la cotización Odoo sin cancelar la venta digital. */
  @Patch('sales/:id/sale-order/clear')
  clearSaleOrder(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: OdooClearSaleOrderDto,
  ) {
    return this.salesService.clearOdooSaleOrderFromOdoo(id, dto.reason);
  }
}
