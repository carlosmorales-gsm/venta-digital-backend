import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import * as os from 'os';
import { AppModule } from './app.module';

function lanIpv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries ?? []) {
      const family = String(net.family);
      if ((family === 'IPv4' || family === '4') && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();

  // Adjuntos (INE / comprobante / PDFs) viajan en base64 dentro del JSON
  app.use(json({ limit: '200mb' }));
  app.use(urlencoded({ extended: true, limit: '200mb' }));

  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });

  const config = app.get(ConfigService);
  const port = Number(config.get('PORT') ?? 3022);
  // Escucha en todas las interfaces para pruebas en LAN (celular / tablet)
  const host = config.get<string>('HOST') || '0.0.0.0';

  await app.listen(port, host);

  // eslint-disable-next-line no-console
  console.log(`Venta Digital API escuchando en http://localhost:${port}/api`);
  for (const ip of lanIpv4Addresses()) {
    // eslint-disable-next-line no-console
    console.log(`  LAN → http://${ip}:${port}/api`);
  }
}

bootstrap();
