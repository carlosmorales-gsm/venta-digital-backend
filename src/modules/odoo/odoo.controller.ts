import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OdooGsmClient } from './odoo-gsm.client';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UserType } from '../../common/enums/user-type.enum';

@Controller('odoo')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class OdooController {
  constructor(private readonly odoo: OdooGsmClient) {}

  /**
   * Proxy a api-odoo-gsm productos/planes.
   * planKind: PARQUE → companyId 1 · PLAN_FUTURO → companyId 2
   */
  @Get('planes')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchPlanes(
    @Query('planKind') planKind: string,
    @Query('q') q?: string,
    @Query('ids') ids?: string,
    @Query('limit') limit?: string,
    @Query('petFuturePlan') petFuturePlan?: string,
  ) {
    const kind = (planKind || '').trim().toUpperCase();
    const companyId: 1 | 2 = kind === 'PARQUE' ? 1 : kind === 'PLAN_FUTURO' ? 2 : 0 as any;
    if (companyId !== 1 && companyId !== 2) {
      throw new BadRequestException(
        'planKind debe ser PARQUE o PLAN_FUTURO',
      );
    }
    const pet = ['1', 'true'].includes(
      String(petFuturePlan || '').trim().toLowerCase(),
    );
    const parsedIds = (ids || '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (parsedIds.length) {
      return this.odoo.getPlanesByIds(companyId, parsedIds, pet);
    }
    if (!(q || '').trim()) {
      throw new BadRequestException('Indica el texto a buscar (q) o ids');
    }
    return this.odoo.searchPlanes(
      companyId,
      q!.trim(),
      limit ? Number(limit) : 20,
      pet,
    );
  }

  @Get('mascotas/especies')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listMascotaEspecies() {
    return this.odoo.listMascotaEspecies();
  }

  @Get('mascotas/razas')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listMascotaRazas(@Query('especieId') especieId?: string) {
    const id = Number(especieId);
    if (!id) throw new BadRequestException('especieId es obligatorio');
    return this.odoo.listMascotaRazas(id);
  }

  @Get('mascotas/tamanos')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listMascotaTamanos() {
    return this.odoo.listMascotaTamanos();
  }

  @Get('clientes')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchClientes(@Query('q') q?: string, @Query('limit') limit?: string) {
    if (!(q || '').trim()) {
      throw new BadRequestException('Indica el nombre del cliente (q)');
    }
    return this.odoo.searchClientes(q!.trim(), limit ? Number(limit) : 20);
  }

  @Get('clientes/:id/suspendidas')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listClienteSuspendidas(@Param('id', ParseIntPipe) id: number) {
    return this.odoo.listClienteSuspendidas(id);
  }

  @Get('clientes/:id/activas')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listClienteActivas(@Param('id', ParseIntPipe) id: number) {
    return this.odoo.listClienteActivas(id);
  }

  @Get('clientes/:id')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  getCliente(@Param('id', ParseIntPipe) id: number) {
    return this.odoo.getCliente(id);
  }

  @Get('sucursales')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listSucursales() {
    return this.odoo.listBranches();
  }

  @Get('parentescos')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listParentescos() {
    return this.odoo.listParentescos();
  }

  @Get('tipos-servicio')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listTiposServicio() {
    return this.odoo.listServiceTypes();
  }

  @Get('empresas-convenio')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  listEmpresasConvenio() {
    return this.odoo.listConvenioCompanies();
  }

  @Get('ubicaciones/parques')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchParques(@Query('q') q?: string, @Query('limit') limit?: string) {
    return this.odoo.searchParques(q, limit ? Number(limit) : 20);
  }

  @Get('ubicaciones/secciones')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchSecciones(
    @Query('parkId') parkId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const id = Number(parkId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new BadRequestException('parkId es obligatorio');
    }
    return this.odoo.searchSecciones(id, q, limit ? Number(limit) : 20);
  }

  @Get('ubicaciones/cuadrantes')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchCuadrantes(
    @Query('parkId') parkId: string,
    @Query('sectionId') sectionId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const park = Number(parkId);
    const section = Number(sectionId);
    if (!Number.isFinite(park) || park <= 0) {
      throw new BadRequestException('parkId es obligatorio');
    }
    if (!Number.isFinite(section) || section <= 0) {
      throw new BadRequestException('sectionId es obligatorio');
    }
    return this.odoo.searchCuadrantes(
      park,
      section,
      q,
      limit ? Number(limit) : 20,
    );
  }

  @Get('ubicaciones/espacios')
  @Roles(UserType.VENDEDOR, UserType.MONITOR, UserType.ADMIN)
  searchEspacios(
    @Query('parkId') parkId: string,
    @Query('sectionId') sectionId: string,
    @Query('quadrantId') quadrantId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    const park = Number(parkId);
    const section = Number(sectionId);
    const quadrant = Number(quadrantId);
    if (!park || !section || !quadrant) {
      throw new BadRequestException(
        'parkId, sectionId y quadrantId son obligatorios',
      );
    }
    return this.odoo.searchEspacios(
      park,
      section,
      quadrant,
      q,
      limit ? Number(limit) : 20,
    );
  }
}
