import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './shared/domain-error.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: { serializers: {req:(request:FastifyRequest)=>({method:request.method,url:request.url?.split('?')[0],hostname:request.hostname,remoteAddress:request.ip})} } }),
    { rawBody: true },
  );
  app.getHttpAdapter().getInstance().addHook('onRequest',(request:FastifyRequest,reply:FastifyReply,done:()=>void)=>{
    if(request.url.startsWith('/api/v1/credit-'))reply.header('cache-control','no-store').header('referrer-policy','no-referrer');
    done();
  });
  // Nest's built-in JSON/form parsers retain decoded resp_data strings. The
  // notification handler rejects arrays/objects (including duplicate form fields)
  // and passes the original business string to the SDK without reserializing.
  await app.register(helmet);
  app.enableCors({ origin: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();
