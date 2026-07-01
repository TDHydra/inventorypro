import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { sendPush } from '../lib/push';

// Registration/unregistration of Expo push tokens + a self-test send.
// NOT wired into index.ts here — the controller registers this plugin at
// `/push` alongside the notification-observer wiring on the client side.
const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  fastify.post<{ Body: { expo_push_token: string; platform?: string; device_id?: string } }>('/register', {
    ...auth,
    schema: { body: { type: 'object', required: ['expo_push_token'],
      properties: { expo_push_token: { type: 'string' }, platform: { type: 'string' }, device_id: { type: 'string' } } } },
  }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { expo_push_token, platform = null, device_id = null } = request.body;
    if (overRateLimit(`push-reg:${userId}`)) return reply.status(429).send({ error: 'rate' });
    // Re-registration moves the token to this user + reactivates it.
    await fastify.pg.query(
      `INSERT INTO device_push_tokens (user_id, expo_push_token, platform, device_id, disabled, last_seen)
       VALUES ($1,$2,$3,$4,FALSE,NOW())
       ON CONFLICT (expo_push_token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
             device_id = EXCLUDED.device_id, disabled = FALSE, last_seen = NOW()`,
      [userId, expo_push_token, platform, device_id],
    );
    return { ok: true };
  });

  fastify.post<{ Body: { expo_push_token: string } }>('/unregister', {
    ...auth,
    schema: { body: { type: 'object', required: ['expo_push_token'], properties: { expo_push_token: { type: 'string' } } } },
  }, async (request) => {
    await fastify.pg.query(`UPDATE device_push_tokens SET disabled = TRUE WHERE expo_push_token = $1`, [request.body.expo_push_token]);
    return { ok: true };
  });

  fastify.post('/test', auth, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const r = await sendPush(fastify.pg, [userId], { title: 'InvenPro test', body: 'Push is working 🎉', data: { screen: 'dashboard' } });
    return { ...r };
  });
};
export default routes;
