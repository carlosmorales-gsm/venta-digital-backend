import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateSettingsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  draftLimit!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  draftTtlHours!: number;

  /** Porcentaje máximo de descuento global (0–100). */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  maxDiscountAmount!: number;

  /** Solo el administrador inicial. Si se omite, no cambia el flag. */
  @IsOptional()
  @IsBoolean()
  sellerPasswordLogin?: boolean;

  /** Contraseña compartida de vendedores. Vacío conserva la actual. */
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(72)
  sellerAccessPassword?: string;
}
