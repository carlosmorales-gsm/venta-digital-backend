import { IsOptional, IsString, Matches } from 'class-validator';

export class SendSignLinkDto {
  /** Origen del front (`window.location.origin`). */
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/[^\s/]+/i, {
    message: 'frontUrl debe ser una URL http(s)',
  })
  frontUrl?: string;
}
