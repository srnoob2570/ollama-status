import { api } from './api';
import { runMonitor } from './monitor';
import type { Env, IncidentEvent } from './types';
import { id, now } from './types';

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/')) return api(request, env, ctx, url.pathname);
        return env.ASSETS.fetch(request);
    },
    async scheduled(
        _controller: ScheduledController,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<void> {
        await runMonitor(env, ctx);
    },
    async queue(batch: MessageBatch<IncidentEvent>, env: Env): Promise<void> {
        for (const message of batch.messages) {
            try {
                await notify(env, message.body);
                message.ack();
            } catch {
                message.retry({ delaySeconds: 30 });
            }
        }
    },
} satisfies ExportedHandler<Env, IncidentEvent>;

async function notify(env: Env, event: IncidentEvent): Promise<void> {
    const destinations = [
        ['discord', env.DISCORD_WEBHOOK_URL, { content: `[Ollama Status] ${event.summary}` }],
        ['webhook', env.GENERIC_WEBHOOK_URL, { type: `incident.${event.eventType}`, ...event }],
    ] as const;
    for (const [destination, url, payload] of destinations) {
        if (!url) continue;
        const deliveryId = id('delivery');
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error(`http_${response.status}`);
            await env.DB.prepare(
                'INSERT INTO notification_deliveries(id,incident_id,destination,event_type,delivered_at,attempts) VALUES (?,?,?,?,?,1)',
            )
                .bind(deliveryId, event.incidentId, destination, event.eventType, now())
                .run();
        } catch (error) {
            await env.DB.prepare(
                'INSERT INTO notification_deliveries(id,incident_id,destination,event_type,attempts,last_error) VALUES (?,?,?,?,1,?)',
            )
                .bind(
                    deliveryId,
                    event.incidentId,
                    destination,
                    event.eventType,
                    error instanceof Error ? error.name : 'delivery_error',
                )
                .run();
            throw error;
        }
    }
}
