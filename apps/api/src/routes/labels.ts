import { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // GET /labels/item/:id/qr.png
  fastify.get<{ Params: { id: string } }>('/item/:id/qr.png', auth, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT id FROM inventory_items WHERE id = $1`,
      [request.params.id]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });

    const buf = await QRCode.toBuffer(`INV:item:${request.params.id}`, {
      type: 'png',
      width: 512,
      margin: 1,
    });
    return reply.type('image/png').send(buf);
  });

  // GET /labels/unit/:assetTag/qr.png
  fastify.get<{ Params: { assetTag: string } }>('/unit/:assetTag/qr.png', auth, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT asset_tag FROM equipment_units WHERE asset_tag = $1`,
      [request.params.assetTag]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });

    const buf = await QRCode.toBuffer(`INV:unit:${request.params.assetTag}`, {
      type: 'png',
      width: 512,
      margin: 1,
    });
    return reply.type('image/png').send(buf);
  });
};

export default routes;
