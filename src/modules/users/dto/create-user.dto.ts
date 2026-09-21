import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { UserType } from '../../../common/enums/user-type.enum';

export class CreateUserDto {
  @IsEnum(UserType, {
    message: 'type debe ser VENDEDOR, MONITOR o ADMIN',
  })
  type: UserType;

  @IsString()
  @MinLength(2)
  fullName: string;

  /** Obligatorio si type = VENDEDOR */
  @ValidateIf((o) => o.type === UserType.VENDEDOR)
  @IsString()
  @Length(10, 10)
  @Matches(/^\d{10}$/)
  cellphone?: string;

  /** Obligatorio si type = MONITOR o ADMIN */
  @ValidateIf(
    (o) => o.type === UserType.MONITOR || o.type === UserType.ADMIN,
  )
  @IsString()
  @MinLength(3)
  username?: string;

  @ValidateIf(
    (o) => o.type === UserType.MONITOR || o.type === UserType.ADMIN,
  )
  @IsString()
  @MinLength(6)
  password?: string;

  /** Solo MONITOR/ADMIN: pedir contraseña nueva en el primer login. */
  @IsOptional()
  @IsBoolean()
  mustChangePassword?: boolean;

  /** Permisos extra opcionales (códigos). Si no se envían, se usan los default. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissionCodes?: string[];

  /** Solo VENDEDOR: nombre que sale en la carátula del contrato. */
  @ValidateIf((o) => o.type === UserType.VENDEDOR)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombreJefeVentas?: string;
}
