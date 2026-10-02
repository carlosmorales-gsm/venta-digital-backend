import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from '../users/entities/user.entity';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { UserType } from '../../common/enums/user-type.enum';
import {
  endOfDayUtcIso,
  secondsUntilEndOfDay,
} from '../../common/utils/end-of-day.util';
import { VerifySellerPinDto } from './dto/verify-seller-pin.dto';
import { MonitorLoginDto } from './dto/monitor-login.dto';
import { UsersRepository } from '../users/repositories/users.repository';
import { RefreshTokensRepository } from '../users/repositories/refresh-tokens.repository';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/enums/audit-action.enum';
import { AuditEntityType } from '../audit/enums/audit-entity-type.enum';
import { AuthUserPayload } from '../../common/decorators/current-user.decorator';

export interface SessionUserView {
  id: number;
  fullName: string;
  type: UserType;
  permissions: string[];
  nombreJefeVentas: string | null;
  mustChangePassword: boolean;
}

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  user: SessionUserView;
}

/** Solo cuando el login exige cambio de contraseña. */
function strongPasswordError(password: string): string | null {
  if (password.length < 8) {
    return 'La nueva contraseña debe tener al menos 8 caracteres';
  }
  if (!/[A-ZÁÉÍÓÚÜÑ]/.test(password)) {
    return 'La nueva contraseña debe incluir al menos una letra mayúscula';
  }
  if (!/\d/.test(password)) {
    return 'La nueva contraseña debe incluir al menos un número';
  }
  if (!/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]/.test(password)) {
    return 'La nueva contraseña debe incluir al menos un carácter especial';
  }
  return null;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly jwtService: JwtService,
    private readonly whatsapp: WhatsappService,
    private readonly config: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  private get businessTimezone(): string {
    return this.config.get<string>('BUSINESS_TIMEZONE') ?? 'America/Mexico_City';
  }

  private permissionCodes(user: User): string[] {
    return (user.userPermissions ?? [])
      .map((up) => up.permission?.code)
      .filter(Boolean);
  }

  private toUserView(user: User): SessionUserView {
    return {
      id: user.id,
      fullName: user.fullName,
      type: user.type,
      permissions: this.permissionCodes(user),
      nombreJefeVentas: user.nombreJefeVentas ?? null,
      mustChangePassword: Boolean(user.mustChangePassword),
    };
  }

  private isDevAuthBypass(): boolean {
    return this.config.get<string>('NODE_ENV') === 'development';
  }

  /**
   * Solo en development: inicia sesión de vendedor con el celular, sin PIN.
   */
  async loginSellerDev(cellphone: string): Promise<AuthTokensResponse> {
    if (!this.isDevAuthBypass()) {
      throw new UnauthorizedException('Login de desarrollo no disponible');
    }

    const seller =
      await this.usersRepository.findActiveSellerByCellphoneWithPermissions(
        cellphone,
      );
    if (!seller) {
      throw new UnauthorizedException('Vendedor no encontrado o inactivo');
    }

    return this.issueSellerSession(seller);
  }

  /**
   * Admin: entra como un vendedor activo (JWT de vendedor hasta fin del día).
   * No revoca el refresh del administrador.
   */
  async enterAsSeller(
    actor: AuthUserPayload,
    sellerId: number,
  ): Promise<AuthTokensResponse> {
    if (actor.type !== UserType.ADMIN) {
      throw new ForbiddenException('Solo un administrador puede entrar como vendedor');
    }

    const seller =
      await this.usersRepository.findActiveByIdWithPermissions(sellerId);

    if (!seller || seller.type !== UserType.VENDEDOR) {
      throw new BadRequestException('Selecciona un vendedor activo');
    }

    const admin = await this.usersRepository.findById(actor.userId);
    await this.auditService.record({
      actor: {
        userId: actor.userId,
        fullName: admin?.fullName ?? null,
        type: actor.type,
      },
      action: AuditAction.APPLY,
      entityType: AuditEntityType.USER,
      entityId: seller.id,
      summary: `Entró como vendedor ${seller.fullName}`,
      details: {
        sellerId: seller.id,
        sellerName: seller.fullName,
      },
    });

    return this.issueSellerSession(seller, actor.userId);
  }

  /**
   * Paso 1 vendedor: valida celular activo y solicita PIN por WhatsApp.
   */
  async requestSellerPin(cellphone: string) {
    const seller =
      await this.usersRepository.findActiveSellerByCellphone(cellphone);

    if (!seller) {
      // Respuesta genérica para no filtrar existencia de números.
      return {
        nipId: null as number | null,
        message: 'Si el número está registrado, recibirá un PIN por WhatsApp',
      };
    }

    const result = await this.whatsapp.sendNip(cellphone);
    if (!result.success || !result.nipId) {
      throw new BadRequestException(
        result.message ?? 'No se pudo enviar el PIN',
      );
    }

    return {
      nipId: result.nipId,
      message: 'PIN enviado por WhatsApp',
    };
  }

  /**
   * Paso 2 vendedor: valida PIN y emite JWT que expira al fin del día.
   */
  async verifySellerPin(dto: VerifySellerPinDto): Promise<AuthTokensResponse> {
    const valid = await this.whatsapp.verifyNip(dto.nipId, dto.nip);
    if (!valid) {
      throw new UnauthorizedException('PIN inválido o expirado');
    }

    const seller =
      await this.usersRepository.findActiveSellerByCellphoneWithPermissions(
        dto.cellphone,
      );

    if (!seller) {
      throw new UnauthorizedException('Vendedor no encontrado o inactivo');
    }

    return this.issueSellerSession(seller);
  }

  private issueSellerSession(
    seller: User,
    impersonatedBy?: number,
  ): AuthTokensResponse {
    const expiresInSeconds = secondsUntilEndOfDay(this.businessTimezone);
    const permissions = this.permissionCodes(seller);
    const accessToken = this.jwtService.sign(
      {
        sub: seller.id,
        type: seller.type,
        permissions,
        tokenUse: 'access',
        ...(impersonatedBy ? { impersonatedBy } : {}),
      },
      { expiresIn: expiresInSeconds },
    );

    return {
      accessToken,
      expiresAt: endOfDayUtcIso(this.businessTimezone),
      user: this.toUserView(seller),
    };
  }

  /**
   * Login MONITOR / ADMIN con usuario y contraseña.
   * Emite access + refresh para mantener la sesión activa.
   */
  async loginMonitor(dto: MonitorLoginDto): Promise<AuthTokensResponse> {
    const user = await this.usersRepository.findActiveByUsernameWithPermissions(
      dto.username,
    );

    if (
      !user ||
      (user.type !== UserType.MONITOR && user.type !== UserType.ADMIN)
    ) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const match = await bcrypt.compare(dto.password, user.passwordHash);
    if (!match) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    return this.issueMonitorTokens(user);
  }

  async refresh(refreshToken: string): Promise<AuthTokensResponse> {
    let payload: any;
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('Refresh token inválido');
    }

    if (payload.tokenUse !== 'refresh') {
      throw new UnauthorizedException('Refresh token inválido');
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored =
      await this.refreshTokensRepository.findByHashWithUser(tokenHash);

    if (
      !stored ||
      stored.revokedAt ||
      stored.expiresAt.getTime() < Date.now() ||
      !stored.user.active
    ) {
      throw new UnauthorizedException('Refresh token revocado o expirado');
    }

    stored.revokedAt = new Date();
    await this.refreshTokensRepository.save(stored);

    return this.issueMonitorTokens(stored.user);
  }

  async logout(refreshToken?: string): Promise<{ message: string }> {
    if (!refreshToken) {
      return { message: 'Sesión cerrada' };
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.refreshTokensRepository.findByHash(tokenHash);
    if (stored && !stored.revokedAt) {
      stored.revokedAt = new Date();
      await this.refreshTokensRepository.save(stored);
    }

    return { message: 'Sesión cerrada' };
  }

  async changeOwnPassword(
    userId: number,
    dto: { currentPassword: string; newPassword: string },
  ) {
    const user = await this.usersRepository.findById(userId);
    if (
      !user ||
      !user.active ||
      (user.type !== UserType.MONITOR && user.type !== UserType.ADMIN)
    ) {
      throw new UnauthorizedException('No puedes cambiar esta contraseña');
    }
    if (!user.passwordHash) {
      throw new BadRequestException('Este usuario no usa contraseña');
    }

    const current = dto.currentPassword;
    const next = dto.newPassword.trim();
    const matches = await bcrypt.compare(current, user.passwordHash);
    if (!matches) {
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    if (user.mustChangePassword) {
      const strength = strongPasswordError(next);
      if (strength) {
        throw new BadRequestException(strength);
      }
    } else if (next.length < 6) {
      throw new BadRequestException(
        'La nueva contraseña debe tener al menos 6 caracteres',
      );
    }
    if (await bcrypt.compare(next, user.passwordHash)) {
      throw new BadRequestException('La nueva contraseña debe ser distinta a la actual');
    }

    user.passwordHash = await bcrypt.hash(next, 10);
    user.mustChangePassword = false;
    await this.usersRepository.save(user);

    const fresh =
      await this.usersRepository.findActiveByIdWithPermissions(user.id);
    return {
      message: 'Contraseña actualizada',
      user: this.toUserView(fresh ?? user),
    };
  }

  async me(userId: number): Promise<SessionUserView> {
    const user =
      await this.usersRepository.findActiveByIdWithPermissions(userId);

    if (!user) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    return this.toUserView(user);
  }

  private async issueMonitorTokens(user: User): Promise<AuthTokensResponse> {
    const permissions = this.permissionCodes(user);
    const accessExpires =
      this.config.get<string>('JWT_ACCESS_EXPIRES') ?? '1h';
    const refreshExpires =
      this.config.get<string>('JWT_REFRESH_EXPIRES') ?? '7d';

    const accessToken = this.jwtService.sign(
      {
        sub: user.id,
        type: user.type,
        permissions,
        tokenUse: 'access',
      },
      { expiresIn: accessExpires as any },
    );

    const refreshToken = this.jwtService.sign(
      {
        sub: user.id,
        type: user.type,
        permissions: [],
        tokenUse: 'refresh',
      },
      { expiresIn: refreshExpires as any },
    );

    const expiresAt = this.computeExpiresAt(accessExpires);
    const refreshExpiresAt = this.computeExpiresAt(refreshExpires);

    await this.refreshTokensRepository.createAndSave({
      user,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: refreshExpiresAt,
      revokedAt: null,
    });

    return {
      accessToken,
      refreshToken,
      expiresAt: expiresAt.toISOString(),
      user: this.toUserView(user),
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /** Interpreta strings tipo 1h / 7d / 15m a Date futura. */
  private computeExpiresAt(expiresIn: string): Date {
    const match = /^(\d+)([smhd])$/.exec(expiresIn);
    if (!match) {
      return new Date(Date.now() + 60 * 60 * 1000);
    }

    const value = Number(match[1]);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };

    return new Date(Date.now() + value * multipliers[unit]);
  }
}
