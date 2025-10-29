import { IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateMessageDto } from './create-message.dto';

export class CreateMessageMultipleDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMessageDto)
  data: CreateMessageDto[];
}
