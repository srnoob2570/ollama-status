import { api } from './api';
import { drainManualMonitorJobs } from './monitor-jobs';
import { runMonitor } from './monitor';
import type { Env } from './types';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return api(request, env, ctx, url.pathname);
        return env.ASSETS.fetch(request);
    },
    async scheduled(
        controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        const job = await drainManualMonitorJobs(env, ctx);
        if (!job) await runMonitor(env, ctx, controller.scheduledTime);
    },
} satisfies ExportedHandler<Env>;
