import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SendNipResult {
  success: boolean;
  nipId?: number;
  message?: string;
}

/**
 * Cliente del API externo de WhatsApp NIP.
 * Flujo basado en api-recibodigital-nest (sendNip / verifyNip).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (this.config.get<string>('API_WHATS') ?? '').trim();
  }

  async sendNip(cellphone: string): Promise<SendNipResult> {
    const originId = Number(this.config.get('WHATSAPP_ORIGIN_ID') ?? 1);
    const expiredTime = Number(
      this.config.get('WHATSAPP_NIP_EXPIRE_MINUTES') ?? 5,
    );

    try {
      const { data } = await axios.post(`${this.baseUrl}nip`, {
        originId,
        phoneNumber: cellphone,
        expiredTime,
      });

      if (data?.success) {
        return { success: true, nipId: data.data.accessNipId };
      }

      return {
        success: false,
        message: data?.message ?? 'No se pudo enviar el PIN',
      };
    } catch (error: any) {
      this.logger.error(`sendNip falló: ${error?.message}`);
      return { success: false, message: 'Error al contactar WhatsApp NIP' };
    }
  }

  async verifyNip(nipId: number, nip: string): Promise<boolean> {
    try {
      const { data } = await axios.get(
        `${this.baseUrl}nip/validate/${nipId}?nip=${nip}`,
      );
      return data?.data?.status == 1;
    } catch (error: any) {
      this.logger.error(`verifyNip falló: ${error?.message}`);
      return false;
    }
  }
}
