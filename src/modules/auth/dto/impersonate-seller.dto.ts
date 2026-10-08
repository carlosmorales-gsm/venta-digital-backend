import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ImpersonateSellerDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sellerId: number;
}
