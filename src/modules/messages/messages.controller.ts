import { Body, Controller, Post } from '@nestjs/common';
import { MessagesService } from './messages.service';
import {
  CreateMessageDto,
  CreateMessageMultipleDto,
  CreateImageMessageDto,
  CreateVideoMessageDto,
  CreateDocumentMessageDto,
} from './dto';

@Controller('send')
export class MessagesController {
  constructor(private readonly message: MessagesService) {}

  @Post('message')
  async sendText(@Body() dto: CreateMessageDto) {
    return this.message.sendMessage(dto);
  }

  @Post('message-multiple')
  async sendTextMultiple(@Body() dto: CreateMessageMultipleDto) {
    return this.message.sendMessageMultiple(dto);
  }

  @Post('image')
  async sendImage(@Body() dto: CreateImageMessageDto) {
    return this.message.sendImage(dto);
  }

  @Post('video')
  async sendVideo(@Body() dto: CreateVideoMessageDto) {
    return this.message.sendVideo(dto);
  }

  @Post('document')
  async sendDocument(@Body() dto: CreateDocumentMessageDto) {
    return this.message.sendDocument(dto);
  }
}
