import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FEVEX_HTTP_PROTOCOL_VERSION_HEADER } from '@fevex/core/http';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    exposedHeaders: [FEVEX_HTTP_PROTOCOL_VERSION_HEADER],
    allowedHeaders: ['content-type', 'last-event-id'],
  });
  await app.listen(3001);
}

void bootstrap();
