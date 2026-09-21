import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './shared/domain-error.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );
  await app.register(helmet);
  app.enableCors({
    origin: [
      process.env.WEB_ORIGIN ?? 'http://localhost:5173',
      process.env.HQ_WEB_ORIGIN ?? 'http://localhost:5174',
      process.env.ATTENDEE_WEB_ORIGIN ?? 'http://localhost:5175',
    ],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
