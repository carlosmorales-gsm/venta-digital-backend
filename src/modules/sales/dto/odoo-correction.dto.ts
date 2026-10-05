import { IsArray, ArrayMinSize, IsIn, IsString } from 'class-validator';
import { CORRECTION_FIELDS } from '../correction-fields';

const KEYS = CORRECTION_FIELDS.map((item) => item.key);

export class OdooCorrectionDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsIn(KEYS, { each: true })
  fields!: string[];
}
