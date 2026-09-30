import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { normalizeMxPhone } from '../sales/utils/phone';

export type TicketNotificationInput = {
  customerName: string;
  amount: number;
  phone?: string | null;
  email?: string | null;
  /** URL pública del PDF (Drive). */
  pdfLink?: string | null;
};

export type SignLinkNotificationInput = {
  customerName: string;
  email?: string | null;
  signUrl: string;
};

/**
 * SMS + correo (API_SMS / n8n) y WhatsApp (API_OMNI).
 * El PDF del ticket se adjunta con la URL de Google Drive.
 */
@Injectable()
export class TicketNotificationService {
  private readonly logger = new Logger(TicketNotificationService.name);

  constructor(private readonly config: ConfigService) {}

  async sendPaymentTicket(input: TicketNotificationInput): Promise<void> {
    const phone = normalizeMxPhone(input.phone);
    const intendedEmail = (input.email || '').trim();
    const email = this.mailTo(intendedEmail);
    const amount = Number.isFinite(input.amount) ? input.amount : 0;
    const formattedAmount = this.formatMexicanPeso(amount);
    const simpleAmount = this.formatSimplePeso(amount);
    const name = (input.customerName || 'Cliente').trim();

    const pdfUrl = (input.pdfLink || '').trim() || null;

    if (phone.length === 10) {
      await this.safe('SMS', () =>
        this.sendSms(
          phone,
          `Hemos recibido tu pago de ${formattedAmount} ✅. 
Gracias por confiar en Grupo San Martín, 
estamos para acompañarte y brindarte seguridad en cada paso.`,
        ),
      );
    } else {
      this.logger.warn('Ticket: sin celular válido; no se envió SMS ni WhatsApp');
    }

    if (email) {
      const betaNote = this.betaNote(intendedEmail, email);
      await this.safe('correo', () =>
        this.sendEmail(
          email,
          `Estimado/a ${name}

Hemos recibido tu pago de ${formattedAmount} ✅
Adjunto encontrarás tu recibo digital correspondiente.${betaNote}

Gracias por confiar en Grupo San Martín. Estamos para acompañarte y brindarte seguridad en cada paso.

Atentamente,
Grupo San Martín`,
          this.isBeta()
            ? '[BETA] Recibo de pago - Grupo San Martín'
            : 'Recibo de pago - Grupo San Martín',
          pdfUrl,
        ),
      );
    } else {
      this.logger.warn('Ticket: sin correo; no se envió email');
    }

    if (phone.length === 10 && pdfUrl) {
      await this.safe('WhatsApp', () =>
        this.sendTicketWhatsapp({
          celular: phone,
          importe: simpleAmount,
          url: pdfUrl,
        }),
      );
    } else if (phone.length === 10 && !pdfUrl) {
      this.logger.warn(
        'Ticket: sin URL pública del PDF; no se envió WhatsApp',
      );
    }
  }

  /** Correo aparte del ticket, solo con el enlace de firma. */
  async sendSignLink(input: SignLinkNotificationInput): Promise<void> {
    const intendedEmail = (input.email || '').trim();
    const email = this.mailTo(intendedEmail);
    const signUrl = (input.signUrl || '').trim();
    if (!email) {
      throw new BadRequestException(
        'El titular no tiene correo para enviar el enlace de firma',
      );
    }
    if (!signUrl) {
      throw new BadRequestException('No se pudo armar el enlace de firma');
    }
    const name = (input.customerName || 'Cliente').trim();
    const betaNote = this.betaNote(intendedEmail, email);
    try {
      await this.sendEmail(
        email,
        `Estimado/a ${name}

Tus documentos están listos para que los leas y firmes. Abre este enlace:

${signUrl}${betaNote}

Gracias por confiar en Grupo San Martín. Estamos para acompañarte y brindarte seguridad en cada paso.

Atentamente,
Grupo San Martín`,
        this.isBeta()
          ? '[BETA] Firma de documentos - Grupo San Martín'
          : 'Firma de documentos - Grupo San Martín',
      );
    } catch (e) {
      const message = (e as Error).message || 'No se pudo enviar el correo';
      this.logger.error(`No se pudo enviar el enlace de firma: ${message}`);
      throw new BadRequestException(
        `No se pudo enviar el enlace de firma: ${message}`,
      );
    }
  }

  private betaNote(intendedEmail: string, email: string): string {
    if (!this.isBeta()) return '';
    if (intendedEmail && intendedEmail !== email) {
      return `\n\n[BETA] El destinatario original era ${intendedEmail}.`;
    }
    return '\n\n[BETA] Correo redirigido a sistemas@sanmartin.com.mx.';
  }

  private async sendSms(celular: string, message: string) {
    const url = this.envUrl('API_SMS');
    if (!url) throw new Error('API_SMS no configurado');
    await axios.post(url, {
      type: 'sms',
      params: {
        to: `52${celular}`,
        message,
      },
    });
  }

  private async sendEmail(
    correo: string,
    body: string,
    subject: string,
    pdfLink?: string | null,
  ) {
    const url = this.envUrl('API_SMS');
    if (!url) throw new Error('API_SMS no configurado');
    await axios.post(url, {
      type: 'email',
      params: {
        body,
        to: correo,
        subject,
        pdfLink: pdfLink || undefined,
      },
    });
  }

  /** Endpoint Omni: POST {API_OMNI}comercial/tickectReciboDigital */
  private async sendTicketWhatsapp(request: {
    celular: string;
    importe: string;
    url: string;
  }) {
    const base = this.envUrl('API_OMNI');
    if (!base) throw new Error('API_OMNI no configurado');
    const url = `${base.replace(/\/+$/, '')}/comercial/tickectReciboDigital`;
    await axios.post(url, request);
  }

  /** Beta / development: no mandar correos al titular. */
  private isBeta(): boolean {
    const env = (this.config.get<string>('NODE_ENV') ?? '').trim().toLowerCase();
    return env !== 'production';
  }

  private mailTo(intended: string): string {
    if (this.isBeta()) return 'sistemas@sanmartin.com.mx';
    return intended;
  }

  private envUrl(key: string): string {
    return (this.config.get<string>(key) ?? '').trim().replace(/^['"]|['"]$/g, '');
  }

  private formatMexicanPeso(amount: number): string {
    return amount.toLocaleString('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
  }

  private formatSimplePeso(amount: number): string {
    return `$${amount.toLocaleString('es-MX', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })}`;
  }

  private async safe(channel: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      this.logger.error(
        `No se pudo enviar el ticket por ${channel}: ${(e as Error).message}`,
      );
    }
  }
}
