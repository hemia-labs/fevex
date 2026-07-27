import { once } from 'node:events';
import { BadRequestException, Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { FevexService } from './fevex.service';

@Controller()
export class AgentsController {
  constructor(private readonly fevex: FevexService) {}

  @Get()
  status() {
    return { name: 'nest-api', status: 'ok' };
  }

  @Get('agents')
  listAgents() {
    return this.fevex.listAgents();
  }

  @Post('agent')
  runDefaultAgent(@Body() body: { input?: unknown }) {
    return this.runAgent('support', body);
  }

  @Post('agents/:name/run')
  async runAgent(@Param('name') name: string, @Body() body: { input?: unknown }) {
    const input = readInput(body);
    const output = await this.fevex.runAgent(name, input);
    return { output };
  }

  @Post('agents/:name/stream')
  async streamAgent(
    @Param('name') name: string,
    @Body() body: { input?: unknown },
    @Req() req: any,
    @Res() res: any,
  ) {
    const input = readInput(body);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('Client disconnected'));
    const events = this.fevex.streamAgent(name, input, controller.signal);

    req.on('close', abort);
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    try {
      for await (const event of events) {
        if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) {
          await Promise.race([once(res, 'drain'), once(res, 'close')]);
          if (res.destroyed) break;
        }
      }
    } finally {
      req.off('close', abort);
      res.end();
    }
  }
}

function readInput(body: { input?: unknown }) {
  if (typeof body.input !== 'string' || !body.input.trim()) {
    throw new BadRequestException('Body must include a non-empty string input.');
  }

  return body.input;
}
