import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  sub: number;
  type: string;
  permissions: string[];
  tokenUse: 'access' | 'refresh';
  impersonatedBy?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'fallback',
    });
  }

  validate(payload: JwtPayload) {
    if (payload.tokenUse !== 'access') {
      throw new UnauthorizedException('Token inválido para esta operación');
    }

    return {
      userId: payload.sub,
      type: payload.type,
      permissions: payload.permissions ?? [],
      impersonatedBy: payload.impersonatedBy,
    };
  }
}
