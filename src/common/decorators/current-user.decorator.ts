import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUserPayload {
  userId: number;
  type: string;
  permissions: string[];
  /** Admin que entró como este vendedor. */
  impersonatedBy?: number;
}

/** Extrae el usuario autenticado que dejó JwtStrategy en request.user */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUserPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
