import { createApi } from '@baromontres/shared/api';
import type { Env } from '@baromontres/shared/schema';

const app = createApi();

export const onRequest: PagesFunction<Env> = (ctx) => app.fetch(ctx.request, ctx.env, ctx);
