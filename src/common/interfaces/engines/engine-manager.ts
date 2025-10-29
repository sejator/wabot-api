import { Injectable, NotFoundException } from '@nestjs/common';
import { AbstractEngine } from './abstract-engine';

@Injectable()
export class EngineManager {
  private engines = new Map<string, AbstractEngine>();

  /**
   * Simpan engine ke dalam registry
   * @param engine Engine yang akan didaftarkan
   * @returns void
   */
  register(engine: AbstractEngine) {
    this.engines.set(engine.name, engine);
  }

  /**
   * Ambil engine berdasarkan nama
   * @param name Nama engine yang akan diambil
   * @returns AbstractEngine yang terdaftar
   * @throws NotFoundException jika engine tidak ditemukan
   */
  get(name: string): AbstractEngine {
    const engine = this.engines.get(name);
    if (!engine) throw new NotFoundException(`Engine ${name} not registered`);
    return engine;
  }
}
