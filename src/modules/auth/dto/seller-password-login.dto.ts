import { IsString, Length, Matches, MinLength } from 'class-validator';

export class SellerPasswordLoginDto {
  @IsString()
  @Length(10, 10, { message: 'El celular debe tener 10 dígitos' })
  @Matches(/^\d{10}$/, { message: 'El celular solo debe contener números' })
  cellphone: string;

  @IsString()
  @MinLength(1)
  password: string;
}
