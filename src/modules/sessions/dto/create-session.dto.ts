import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  IsInt,
  Min,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { EngineType } from 'src/common/types/session.type';

class SessionAttributesDto {
  @IsOptional()
  @IsInt({ message: 'message_delay harus berupa angka' })
  @Min(0, { message: 'message_delay minimal 0 ms' })
  message_delay?: number;

  @IsOptional()
  @IsUrl({}, { message: 'webhook_incoming harus berupa URL yang valid' })
  webhook_incoming?: string;

  @IsOptional()
  @IsUrl({}, { message: 'webhook_status harus berupa URL yang valid' })
  webhook_status?: string;

  @IsOptional()
  @IsString({ message: 'webhook_secret harus berupa string' })
  webhook_secret?: string;

  @IsOptional()
  quota?: number | null; // null = unlimited, 0 = tidak bisa kirim
}

export class CreateSessionDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  engine: EngineType;

  @IsOptional()
  @ValidateNested()
  @Type(() => SessionAttributesDto)
  attributes?: SessionAttributesDto;
}
