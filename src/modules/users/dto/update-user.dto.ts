import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Edición de usuario.
 * El tipo no se cambia por aquí.
 * password es opcional: si se omite, se conserva el hash actual.
 */
export class UpdateUserDto {
  @IsString()
  @MinLength(2)
  fullName: string;

  @IsOptional()
  @IsString()
  @Length(10, 10)
  @Matches(/^\d{10}$/)
  cellphone?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsBoolean()
  mustChangePassword?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nombreJefeVentas?: string;
}
