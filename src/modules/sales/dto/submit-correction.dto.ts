import { IsObject } from 'class-validator';

export class SubmitCorrectionDto {
  @IsObject()
  values!: Record<string, unknown>;
}
