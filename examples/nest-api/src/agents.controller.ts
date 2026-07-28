import { once } from 'node:events';
import { All, Controller, Get, Req, Res } from '@nestjs/common';
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

  @Get('workflows')
  listWorkflows() {
    return this.fevex.listWorkflows();
  }

  @All([
    'v1/agents/:name/runs',
    'v1/workflows/:name/runs',
    'v1/runs/:runId',
    'v1/runs/:runId/events',
    'v1/runs/:runId/resume',
  ])
  async protocol(@Req() req: any, @Res() res: any) {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
    };
    res.on('close', abort);

    try {
      const headers = new Headers();
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index];
        if (!['connection', 'content-length', 'host', 'transfer-encoding'].includes(
          name.toLowerCase(),
        )) {
          headers.append(name, req.rawHeaders[index + 1]);
        }
      }
      const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(['GET', 'HEAD'].includes(req.method)
          ? {}
          : { body: JSON.stringify(req.body ?? {}) }),
        signal: controller.signal,
      });
      const response = await this.fevex.http(request);
      res.status(response.status);
      response.headers.forEach((value: string, name: string) => res.setHeader(name, value));

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
              await Promise.race([once(res, 'drain'), once(res, 'close')]);
              if (res.destroyed) break;
            }
          }
        } finally {
          if (res.destroyed) await reader.cancel();
          reader.releaseLock();
        }
      }
    } finally {
      res.off('close', abort);
      res.end();
    }
  }
}
