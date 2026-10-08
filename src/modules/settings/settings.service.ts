import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { AppSettings } from './entities/app-settings.entity';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { DiscountsService } from '../discounts/discounts.service';
import { AuditService, diffChanges } from '../audit/audit.service';
import { AuditAction } from '../audit/enums/audit-action.enum';
import { AuditEntityType } from '../audit/enums/audit-entity-type.enum';
import { UsersRepository } from '../users/repositories/users.repository';
import { AuthUserPayload } from '../../common/decorators/current-user.decorator';
import { UserType } from '../../common/enums/user-type.enum';
import {
  calendarDateInZone,
  endOfNextCalendarDay,
} from '../../common/utils/end-of-day.util';

const SETTINGS_ID = 1;
const DEFAULT_DRAFT_LIMIT = 3;
const DEFAULT_DRAFT_TTL_HOURS = 24;
const DEFAULT_MAX_DISCOUNT = 0;

function moneyNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type SellerAccessState = {
  sellerPasswordLogin: boolean;
  sellerAccessPasswordHash: string | null;
  sellerAccessPasswordExpiresAt: Date | string | null;
};

function sellerAccessActive(row: SellerAccessState, now = new Date()): boolean {
  const expires = asDate(row.sellerAccessPasswordExpiresAt);
  return (
    Boolean(row.sellerPasswordLogin) &&
    Boolean(row.sellerAccessPasswordHash) &&
    expires != null &&
    expires.getTime() > now.getTime()
  );
}

function sellerAccessExpired(row: SellerAccessState, now = new Date()): boolean {
  const expires = asDate(row.sellerAccessPasswordExpiresAt);
  return (
    Boolean(row.sellerPasswordLogin) &&
    Boolean(row.sellerAccessPasswordHash) &&
    expires != null &&
    expires.getTime() <= now.getTime()
  );
}

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    @InjectRepository(AppSettings)
    private readonly repo: Repository<AppSettings>,
    private readonly discountsService: DiscountsService,
    private readonly auditService: AuditService,
    private readonly usersRepository: UsersRepository,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.ensureDefaults();
  }

  async ensureDefaults() {
    const existing = await this.repo.findOne({ where: { id: SETTINGS_ID } });
    if (existing) return existing;

    const row = this.repo.create({
      id: SETTINGS_ID,
      draftLimit: DEFAULT_DRAFT_LIMIT,
      draftTtlHours: DEFAULT_DRAFT_TTL_HOURS,
      maxDiscountAmount: String(DEFAULT_MAX_DISCOUNT),
      sellerPasswordLogin: false,
      sellerAccessPasswordHash: null,
      sellerAccessPasswordExpiresAt: null,
    });
    return this.repo.save(row);
  }

  async get(): Promise<AppSettings> {
    const row = await this.repo.findOne({ where: { id: SETTINGS_ID } });
    if (row) return row;
    return this.ensureDefaults();
  }

  async getDraftPolicy() {
    const s = await this.get();
    return {
      draftLimit: s.draftLimit,
      draftTtlHours: s.draftTtlHours,
    };
  }

  /** Política de captura para el vendedor (borradores + tope de descuento). */
  async getSellerCapturePolicy(userId: number) {
    const s = await this.get();
    const maxDiscountAmount = moneyNum(s.maxDiscountAmount);
    const descuentoEspecial =
      await this.discountsService.activeSpecialMaxForSeller(userId);
    return {
      draftLimit: s.draftLimit,
      draftTtlHours: s.draftTtlHours,
      maxDiscountAmount,
      descuentoEspecial,
      allowedDiscountMax: Math.max(maxDiscountAmount, descuentoEspecial),
    };
  }

  async allowedDiscountMaxForUser(userId: number): Promise<number> {
    const policy = await this.getSellerCapturePolicy(userId);
    return policy.allowedDiscountMax;
  }

  async getGlobalMaxDiscount(): Promise<number> {
    const s = await this.get();
    return moneyNum(s.maxDiscountAmount);
  }

  /** Usuario sembrado con ADMIN_USERNAME (por defecto ADMIN). */
  async isDefaultAdmin(userId: number): Promise<boolean> {
    const user = await this.usersRepository.findById(userId);
    if (!user || user.type !== UserType.ADMIN || !user.active) return false;
    const expected = (this.config.get<string>('ADMIN_USERNAME') ?? 'admin')
      .trim()
      .toUpperCase();
    return (user.username ?? '').trim().toUpperCase() === expected;
  }

  private get businessTimezone(): string {
    return (
      this.config.get<string>('BUSINESS_TIMEZONE')?.trim() ||
      'America/Mexico_City'
    );
  }

  /** Modo público del login de vendedor. No incluye la contraseña. */
  async getSellerAccessMode(): Promise<{
    passwordLogin: boolean;
    expired: boolean;
  }> {
    const s = await this.get();
    return {
      passwordLogin: sellerAccessActive(s),
      expired: sellerAccessExpired(s),
    };
  }

  async assertSellerPassword(
    password: string,
  ): Promise<{ ok: true } | { ok: false; expired: boolean }> {
    const s = await this.get();
    if (!sellerAccessActive(s)) {
      return { ok: false, expired: sellerAccessExpired(s) };
    }
    const match = await bcrypt.compare(password, s.sellerAccessPasswordHash!);
    return match ? { ok: true } : { ok: false, expired: false };
  }

  async update(
    dto: UpdateSettingsDto,
    actor?: AuthUserPayload | null,
  ): Promise<AppSettings> {
    const row = await this.get();
    const before = {
      draftLimit: row.draftLimit,
      draftTtlHours: row.draftTtlHours,
      maxDiscountAmount: moneyNum(row.maxDiscountAmount),
    };

    const touchesSellerAccess =
      dto.sellerPasswordLogin !== undefined ||
      Boolean(dto.sellerAccessPassword?.trim());
    if (touchesSellerAccess) {
      const allowed = actor ? await this.isDefaultAdmin(actor.userId) : false;
      if (!allowed) {
        throw new ForbiddenException(
          'Solo el administrador inicial puede cambiar el acceso de los vendedores',
        );
      }
    }

    row.draftLimit = dto.draftLimit;
    row.draftTtlHours = dto.draftTtlHours;
    row.maxDiscountAmount = String(dto.maxDiscountAmount ?? 0);

    const passwordBefore = Boolean(row.sellerAccessPasswordHash);
    const flagBefore = Boolean(row.sellerPasswordLogin);
    const expiresBefore = asDate(row.sellerAccessPasswordExpiresAt);
    let nextFlag = row.sellerPasswordLogin;
    if (dto.sellerPasswordLogin !== undefined) {
      nextFlag = dto.sellerPasswordLogin;
    }
    const nextPassword = dto.sellerAccessPassword?.trim();
    let nextHash = row.sellerAccessPasswordHash;
    let nextExpires = expiresBefore;
    if (nextFlag && nextPassword) {
      nextHash = await bcrypt.hash(nextPassword, 10);
      nextExpires = endOfNextCalendarDay(this.businessTimezone);
    }
    if (!nextFlag) {
      nextHash = null;
      nextExpires = null;
    }
    if (
      nextFlag &&
      !sellerAccessActive({
        sellerPasswordLogin: nextFlag,
        sellerAccessPasswordHash: nextHash,
        sellerAccessPasswordExpiresAt: nextExpires,
      })
    ) {
      throw new BadRequestException(
        'Define la contraseña de los vendedores antes de activar el acceso',
      );
    }
    row.sellerPasswordLogin = nextFlag;
    row.sellerAccessPasswordHash = nextHash;
    row.sellerAccessPasswordExpiresAt = nextExpires;

    const saved = await this.repo.save(row);

    const after = {
      draftLimit: saved.draftLimit,
      draftTtlHours: saved.draftTtlHours,
      maxDiscountAmount: moneyNum(saved.maxDiscountAmount),
    };
    const changes = diffChanges(before, after);
    if (flagBefore !== Boolean(saved.sellerPasswordLogin)) {
      changes.sellerPasswordLogin = {
        from: flagBefore,
        to: Boolean(saved.sellerPasswordLogin),
      };
    }
    if (nextPassword && saved.sellerPasswordLogin) {
      changes.sellerAccessPassword = { from: 'oculto', to: 'actualizada' };
      const expiresAfter = asDate(saved.sellerAccessPasswordExpiresAt);
      changes.sellerAccessPasswordExpiresAt = {
        from: expiresBefore?.toISOString() ?? null,
        to: expiresAfter?.toISOString() ?? null,
      };
    } else if (passwordBefore && !saved.sellerAccessPasswordHash) {
      changes.sellerAccessPassword = { from: 'definida', to: 'eliminada' };
    }

    if (Object.keys(changes).length && actor) {
      const actorUser = await this.usersRepository.findById(actor.userId);
      const actorName = actorUser?.fullName ?? 'Administrador';
      await this.auditService.record({
        actor: {
          userId: actor.userId,
          fullName: actorName,
          type: actor.type,
        },
        action: AuditAction.UPDATE,
        entityType: AuditEntityType.SETTINGS,
        entityId: SETTINGS_ID,
        summary: `${actorName} actualizó la configuración del sistema`,
        details: { changes },
      });
    }

    return saved;
  }

  toPublic(s: AppSettings, canManageSellerAccess = false) {
    const expires = asDate(s.sellerAccessPasswordExpiresAt);
    const active = sellerAccessActive(s);
    const expired = sellerAccessExpired(s);
    const expiresOn = expires
      ? calendarDateInZone(
          this.businessTimezone,
          new Date(expires.getTime() - 1),
        )
      : null;
    return {
      draftLimit: s.draftLimit,
      draftTtlHours: s.draftTtlHours,
      maxDiscountAmount: moneyNum(s.maxDiscountAmount),
      sellerPasswordLogin: active,
      sellerPasswordDefined: active,
      sellerPasswordExpiresAt: expires?.toISOString() ?? null,
      sellerPasswordExpiresOn: active || expired ? expiresOn : null,
      sellerPasswordExpired: expired,
      canManageSellerAccess,
      updatedAt: s.updatedAt?.toISOString() ?? null,
    };
  }
}
