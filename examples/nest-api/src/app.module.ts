import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { PreviewController } from './preview.controller';
import { FevexService } from './fevex.service';

@Module({
  controllers: [AgentsController, PreviewController],
  providers: [FevexService],
})
export class AppModule {}
