import {
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  IsInt,
  Min,
  IsUrl,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { EngineType } from 'src/common/types/session.type';

@ValidatorConstraint({ name: 'WebhookRelation', async: false })
class WebhookRelationConstraint implements ValidatorConstraintInterface {
  validate(_: any, args: ValidationArguments) {
    const obj = args.object as SessionAttributesDto;
    if (obj.webhook_status && !obj.webhook_incoming) {
      return false;
    }
    return true;
  }

  defaultMessage(args: ValidationArguments) {
    return `webhook_incoming harus diisi jika webhook_status aktif ${args.property}`;
  }
}

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

  @Validate(WebhookRelationConstraint)
  relationValidator: boolean;
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
