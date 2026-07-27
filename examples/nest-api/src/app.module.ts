import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { FevexService } from './fevex.service';

@Module({
  controllers: [AgentsController],
  providers: [FevexService],
})
export class AppModule {}
