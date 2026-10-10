// /api/* へのリクエストをすべて src/server.js に渡す（Cloudflare Pages Functions）
import { handle } from '../../src/server.js';

export const onRequest = (context) => handle(context.request, context.env);
