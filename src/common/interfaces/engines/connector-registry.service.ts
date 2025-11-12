import { Injectable } from '@nestjs/common';
import { Connector } from 'src/common/types/session.type';

@Injectable()
export class ConnectorRegistry<TConnector extends Connector = Connector> {
  private readonly connectors = new Map<string, TConnector>();

  /**
   * Simpan connector aktif ke dalam registry
   * @param connector Connector yang akan didaftarkan
   * @returns void
   */
  register(connector: TConnector) {
    this.connectors.set(connector.sessionId, connector);
  }

  /**
   * Ambil connector berdasarkan session_id
   * @param session_id ID sesi untuk mengambil connector
   * @returns Connector yang terdaftar atau null jika tidak ditemukan atau tidak terhubung
   */
  get(session_id: string): TConnector | null {
    const connector = this.connectors.get(session_id);
    if (!connector || !connector.isConnected()) return null;
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
