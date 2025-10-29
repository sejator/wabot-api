import {
  IsNotEmpty,
  IsString,
  IsUrl,
  IsOptional,
  IsBoolean,
} from 'class-validator';

export class CreateVideoMessageDto {
  @IsString()
  @IsNotEmpty()
  session_id: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsUrl()
  @IsNotEmpty()
  video: string;

  @IsString()
  @IsOptional()
  caption?: string;

  @IsBoolean()
  @IsOptional()
  isGroup?: boolean;
}
