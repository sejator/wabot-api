import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { UpdateSessionDto } from './dto/update-session.dto';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async find(@Query('name') name: string) {
    return await this.sessions.find(name);
  }

  @Post()
  async create(@Body() dto: CreateSessionDto) {
    return await this.sessions.create(dto);
  }

  @Post(':id/connect')
  @HttpCode(200)
  async connect(@Param('id') id: string) {
    return await this.sessions.connect(id);
  }

  @Post(':id/reconnect')
  @HttpCode(200)
  async reconnect(@Param('id') id: string) {
    return await this.sessions.reconnect(id);
  }

  @Put(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() dto: UpdateSessionDto) {
    return await this.sessions.update(id, dto);
  }

  @Delete(':id')
  async stop(@Param('id') id: string) {
    return await this.sessions.stop(id);
  }

  /**
   * Force delete session/connector dari in-memory registry.
   * Mengembalikan objek { ok: boolean, message: string, sessionId?: string }
   */
  @Delete(':id/force')
  async forceDelete(@Param('id') id: string) {
    return await this.sessions.forceDelete(id);
  }
}
