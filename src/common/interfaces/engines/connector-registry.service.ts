import { Injectable, NotFoundException } from '@nestjs/common';
import { Connector } from 'src/common/types/session.type';

@Injectable()
export class ConnectorRegistry<TConnector extends Connector = Connector> {
  private readonly connectors = new Map<string, TConnector>();

  /**
   * Simpan connector aktif ke dalam registry
   * @param connector Connector yang akan didaftarkan
   * @returns void
   * @throws Error jika connector tidak memiliki session.id
   */
  register(connector: TConnector) {
    if (!connector.sessionId) {
      throw new Error('Connector must have session.id');
    }
    this.connectors.set(connector.sessionId, connector);
  }

  /**
   * Ambil connector berdasarkan session_id
   * @param session_id ID sesi untuk mengambil connector
   * @returns Connector yang terdaftar
   * @throws NotFoundException jika connector tidak ditemukan atau sesi tidak terhubung
   */
  get(session_id: string): TConnector {
    const connector = this.connectors.get(session_id);
    if (!connector)
      throw new NotFoundException(`Session ${session_id} not found`);

    if (!connector.isConnected()) {
      throw new NotFoundException(`Session ${session_id} is not connected`);
    }

    return connector;
  }

  /**
   * Hapus connector dari registry
   * @param session_id ID sesi yang akan dihapus
   * @returns void
   */
  unregister(session_id: string) {
    this.connectors.delete(session_id);
  }

  /**
   * Cek apakah connector dengan session_id tertentu terdaftar
   * @param session_id ID sesi yang akan dicek
   * @returns boolean
   */
  has(session_id: string): boolean {
    return this.connectors.has(session_id);
  }

  /**
   * Ambil semua connector aktif
   * @returns Connector[] yang terdaftar
   */
  getAll(): TConnector[] {
    return Array.from(this.connectors.values());
  }
}
