import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SalesService } from './sales.service';
import {
  CurrentUser,
  AuthUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { UserType } from '../../common/enums/user-type.enum';
import { PermissionCode } from '../../common/constants/permissions.constants';
import {
  SavePaymentDto,
  SignSaleDto,
  UpsertSaleDto,
} from './dto/sale-form.dto';
import { SubmitCorrectionDto } from './dto/submit-correction.dto';
import { SendSignLinkDto } from './dto/send-sign-link.dto';

@Controller('sales')
@UseGuards(AuthGuard('jwt'), RolesGuard, PermissionsGuard)
export class SalesController {
  constructor(private readonly salesService: SalesService) {}

  /** Listado: el JWT define el alcance (vendedor = propias, mesa = global). */
  @Get()
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  list(@CurrentUser() user: AuthUserPayload) {
    if (user.type === UserType.VENDEDOR) {
      return this.salesService.listOwnSales(user.userId);
    }
    if (
      user.type !== UserType.ADMIN &&
      !user.permissions.includes(PermissionCode.VENTAS_VER)
    ) {
      throw new ForbiddenException('No tiene permisos suficientes');
    }
    return this.salesService.listAllSales();
  }

  /** Busca ventas de cualquier vendedor para precargar titular / contactos. */
  @Get('reuse')
  @Roles(UserType.VENDEDOR)
  reuse(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.salesService.searchReferences(
      q,
      limit ? Number(limit) : 20,
    );
  }

  @Get(':id')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  getOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.salesService.getOne(id, user);
  }

  @Post('drafts')
  @Roles(UserType.VENDEDOR)
  createDraft(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.createDraft(user, dto);
  }

  @Patch(':id/draft')
  @Roles(UserType.VENDEDOR)
  updateDraft(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.updateDraft(id, user, dto);
  }

  /** Finaliza captura (sin pago ni firma). */
  @Post('finalize')
  @Roles(UserType.VENDEDOR)
  finalizeNew(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.finalizeCapture(null, user, dto);
  }

  @Post(':id/finalize')
  @Roles(UserType.VENDEDOR)
  finalizeExisting(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.finalizeCapture(id, user, dto);
  }

  /** Compat con front anterior. */
  @Post('submit')
  @Roles(UserType.VENDEDOR)
  submitNew(
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.finalizeCapture(null, user, dto);
  }

  @Post(':id/submit')
  @Roles(UserType.VENDEDOR)
  submitExisting(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: UpsertSaleDto,
  ) {
    return this.salesService.finalizeCapture(id, user, dto);
  }

  @Patch(':id/payment')
  @Roles(UserType.VENDEDOR)
  savePayment(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: SavePaymentDto,
  ) {
    return this.salesService.savePayment(id, user, dto);
  }

  /** Correo aparte del ticket, con el enlace para que el cliente firme. */
  @Post(':id/sign-link')
  @Roles(UserType.VENDEDOR)
  sendSignLink(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: SendSignLinkDto,
    @Headers('origin') origin?: string,
    @Headers('referer') referer?: string,
  ) {
    return this.salesService.sendClientSignLink(id, user, [
      dto.frontUrl,
      origin,
      referer,
    ]);
  }

  @Post(':id/correction')
  @Roles(UserType.VENDEDOR)
  submitCorrection(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: SubmitCorrectionDto,
  ) {
    return this.salesService.submitSellerCorrection(id, user, dto.values);
  }

  @Post(':id/sign')
  @Roles(UserType.VENDEDOR)
  sign(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
    @Body() dto: SignSaleDto,
  ) {
    return this.salesService.signSale(id, user, dto);
  }

  @Delete(':id')
  @Roles(UserType.VENDEDOR)
  deleteDraft(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUserPayload,
  ) {
    return this.salesService.deleteDraft(id, user);
  }
}
