import { IsArray, ArrayMinSize, IsIn, IsString } from 'class-validator';
import { CORRECTION_KEYS } from '../correction-fields';

const KEYS = CORRECTION_KEYS;

export class OdooCorrectionDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsIn(KEYS, { each: true })
  fields!: string[];
}
