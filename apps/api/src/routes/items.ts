import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';
import { overLimit } from '../lib/rateLimit';

interface CreateItemBody {
  name: string;
  barcode?: string;
  description?: string;
  sku?: string;
  supplier?: string;
  model?: string;
  kind?: 'product' | 'equipment';
  category?: string;
  returnable?: boolean;
  // Now a configurable product_class id (taxonomy_types). Legacy keys remapped in migration 012.
  unit_category: string;
  unit: string;
  min_qty_alert?: number;
  reorder_to?: number;
  unit_tracked?: boolean;
  tag_prefix?: string;
}

interface UpdateItemBody extends Partial<CreateItemBody> {
  active?: boolean;
}

interface StockAdjustBody {
  location_id: string;
  quantity: number;
  note?: string;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // GET /items — catalog list with optional search
  fastify.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
    '/', {
      ...auth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    }, async (request, reply) => {
      const sub = (request.user as { sub: string }).sub;
      if (overLimit('items:' + sub, 60)) return reply.status(429).send({ error: 'rate' });
      const { q = '', limit = '50', offset = '0' } = request.query;
      const lim = Math.min(parseInt(limit, 10), 200);
      const off = parseInt(offset, 10);

      if (q.trim()) {
        const { rows } = await fastify.pg.query(
          `SELECT i.*,
                CASE WHEN i.unit_tracked
                     THEN (SELECT COUNT(*) FROM equipment_units eu WHERE eu.item_id = i.id AND eu.status = 'available')
                     ELSE COALESCE(SUM(s.quantity), 0) END as total_stock
           FROM inventory_items i
           LEFT JOIN stock_by_location s ON s.item_id = i.id
           WHERE i.active = true AND (i.name ILIKE $1 OR i.barcode ILIKE $1)
           GROUP BY i.id
           ORDER BY i.name ASC
           LIMIT $2 OFFSET $3`,
          [`%${q}%`, lim, off]
        );
        return { items: rows };
      }

      const { rows } = await fastify.pg.query(
        `SELECT i.*,
                CASE WHEN i.unit_tracked
                     THEN (SELECT COUNT(*) FROM equipment_units eu WHERE eu.item_id = i.id AND eu.status = 'available')
                     ELSE COALESCE(SUM(s.quantity), 0) END as total_stock
         FROM inventory_items i
         LEFT JOIN stock_by_location s ON s.item_id = i.id
         WHERE i.active = true
         GROUP BY i.id
         ORDER BY i.name ASC
         LIMIT $1 OFFSET $2`,
        [lim, off]
      );
      return { items: rows };
    }
  );

  // GET /items/:id
  fastify.get<{ Params: { id: string } }>('/:id', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT i.*,
              json_agg(json_build_object('location_id', s.location_id, 'quantity', s.quantity, 'location_name', l.name)) as stock
       FROM inventory_items i
       LEFT JOIN stock_by_location s ON s.item_id = i.id
       LEFT JOIN locations l ON l.id = s.location_id
       WHERE i.id = $1
       GROUP BY i.id`,
      [request.params.id]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // GET /items/barcode/:code
  fastify.get<{ Params: { code: string } }>('/barcode/:code', {
    ...auth,
    schema: {
      params: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT * FROM inventory_items WHERE barcode = $1 AND active = true`,
      [request.params.code]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // POST /items — create catalog item
  fastify.post<{ Body: CreateItemBody }>('/', {
    preHandler: [(fastify as any).authenticate, requirePermission('add_inventory')],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'unit_category', 'unit'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          barcode: { type: 'string', maxLength: 128 },
          description: { type: 'string', maxLength: 2000 },
          sku: { type: 'string', maxLength: 128 },
          supplier: { type: 'string', maxLength: 200 },
          model: { type: 'string', maxLength: 200 },
          kind: { type: 'string', enum: ['product', 'equipment'] },
          category: { type: 'string', maxLength: 128 },
          returnable: { type: 'boolean' },
          unit_category: { type: 'string', minLength: 1, maxLength: 64 },
          unit: { type: 'string', minLength: 1, maxLength: 32 },
          min_qty_alert: { type: 'integer', minimum: 0 },
          reorder_to: { type: 'integer', minimum: 0 },
          unit_tracked: { type: 'boolean' },
          tag_prefix: { type: 'string', maxLength: 32 },
        },
      },
    },
  }, async (request, reply) => {
    const {
      name, barcode, description, sku, supplier, model,
      kind = 'product', category, returnable = false,
      unit_category, unit, min_qty_alert = 0, reorder_to,
      unit_tracked = false, tag_prefix,
    } = request.body;
    const { rows } = await fastify.pg.query(
      // category_id dual-writes the taxonomy FK (#74), resolved from the label.
      `INSERT INTO inventory_items
         (name, barcode, description, sku, supplier, model, kind, category, returnable,
          unit_category, unit, min_qty_alert, reorder_to, unit_tracked, tag_prefix, category_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          (SELECT id FROM taxonomy_types WHERE category = 'item_category' AND label = $8
           ORDER BY active DESC, sort_order ASC, id ASC LIMIT 1))
       RETURNING *`,
      [name, barcode ?? null, description ?? null, sku ?? null, supplier ?? null, model ?? null,
       kind, category ?? null, returnable, unit_category, unit, min_qty_alert,
       reorder_to ?? null, unit_tracked, tag_prefix ?? null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /items/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateItemBody }>(
    '/:id', {
      preHandler: [(fastify as any).authenticate, requirePermission('edit_inventory')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            barcode: { type: 'string', maxLength: 128 },
            description: { type: 'string', maxLength: 2000 },
            sku: { type: 'string', maxLength: 128 },
            supplier: { type: 'string', maxLength: 200 },
            model: { type: 'string', maxLength: 200 },
            kind: { type: 'string', enum: ['product', 'equipment'] },
            category: { type: 'string', maxLength: 128 },
            returnable: { type: 'boolean' },
            unit_category: { type: 'string', minLength: 1, maxLength: 64 },
            unit: { type: 'string', minLength: 1, maxLength: 32 },
            min_qty_alert: { type: 'integer', minimum: 0 },
            reorder_to: { type: 'integer', minimum: 0 },
            unit_tracked: { type: 'boolean' },
            tag_prefix: { type: 'string', maxLength: 32 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const fields = request.body;
      const allowed = ['name','barcode','description','sku','supplier','model','kind','category',
        'returnable','unit_category','unit','min_qty_alert','reorder_to','unit_tracked','tag_prefix','active'];
      const updates = Object.entries(fields)
        .filter(([k]) => allowed.includes(k))
        .map(([k], i) => `${k} = $${i + 2}`);

      if (updates.length === 0) return reply.status(400).send({ error: 'No valid fields' });

      const values = Object.entries(fields)
        .filter(([k]) => allowed.includes(k))
        .map(([, v]) => v);

      const { rows } = await fastify.pg.query(
        `UPDATE inventory_items SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [request.params.id, ...values]
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
      return rows[0];
    }
  );

  // POST /items/:id/stock — adjust stock at a location
  fastify.post<{ Params: { id: string }; Body: StockAdjustBody }>(
    '/:id/stock', {
      preHandler: [(fastify as any).authenticate, requirePermission('add_inventory')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          required: ['location_id', 'quantity'],
          properties: {
            location_id: { type: 'string', minLength: 1, maxLength: 64 },
            // Adjustment delta — may be negative to decrement stock.
            quantity: { type: 'integer' },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const { location_id, quantity } = request.body;
      const { rows } = await fastify.pg.query(
        `INSERT INTO stock_by_location (item_id, location_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (item_id, location_id)
         DO UPDATE SET quantity = stock_by_location.quantity + EXCLUDED.quantity, updated_at = NOW()
         RETURNING *`,
        [request.params.id, location_id, quantity]
      );
      return rows[0];
    }
  );
};

export default routes;
