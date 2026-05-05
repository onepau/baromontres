import { createApi } from '@baromontres/shared/api';
import type { Env } from '@baromontres/shared/schema';

const api = createApi();

export interface WorkerEnv extends Env {
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return api.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};
