// Shared request-schema shapes.
//
// Fastify's default Ajv has NO ajv-formats registered, so `format: 'uuid'` /
// `format: 'email'` in a route schema is silently ignored — it validates
// nothing. These shapes use `pattern` + bounds, which the default Ajv actually
// enforces. Use them instead of `format:` anywhere a route schema needs a
// UUID or an email.

// Must look like the UUID primary keys it is matched against (users.id etc.).
export const UUID_SCHEMA = {
  type: 'string',
  maxLength: 36,
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const;

// Pragmatic email shape: something@something.tld, no whitespace, bounded at
// the RFC 5321 254-char address limit. Deliverability is proven by sending,
// not by regex — this only rejects obvious junk at the schema layer.
export const EMAIL_SCHEMA = {
  type: 'string',
  maxLength: 254,
  pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
} as const;
