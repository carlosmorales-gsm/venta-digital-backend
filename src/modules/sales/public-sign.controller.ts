import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SignSaleDto } from './dto/sale-form.dto';
import { OdooGsmClient } from '../odoo/odoo-gsm.client';
import { SalesService } from './sales.service';

/** Firma remota del titular: sin JWT de vendedor. El token va en la URL del correo. */
@Controller('public/sign')
export class PublicSignController {
  constructor(
    private readonly salesService: SalesService,
    private readonly odoo: OdooGsmClient,
  ) {}

  @Get('origenes-venta')
  listOrigenesVenta() {
    return this.odoo.listSaleOrigins();
  }

  @Get(':token')
  getSale(@Param('token') token: string) {
    return this.salesService.getForClientSign(token);
  }

  @Post(':token')
  sign(@Param('token') token: string, @Body() dto: SignSaleDto) {
    return this.salesService.signSaleByClientToken(token, dto);
  }
}
