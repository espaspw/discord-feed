export const resourceParamsSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
  },
};

export const feedBodySchema = {
  type: 'object',
  required: ['name', 'tags', 'webhookNames'],
  properties: {
    name: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    webhookNames: { type: 'array', items: { type: 'string' } },
    pollingIntervalMs: { type: 'number', minimum: 1000 },
    batchSize: { type: 'number', minimum: 1 },
    username: { type: 'string' },
    avatarUrl: { type: 'string', format: 'uri' },
  },
};

export const feedUpdateBodySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    webhookNames: { type: 'array', items: { type: 'string' } },
    pollingIntervalMs: { type: 'number', minimum: 1000 },
    batchSize: { type: 'number', minimum: 1 },
    username: { type: 'string' },
    avatarUrl: { type: 'string', format: 'uri' },
  },
  minProperties: 1,
};

export const feedLastIdUpdateBodySchema = {
  type: 'object',
  required: ['lastId'],
  properties: {
    lastId: { type: 'number', minimum: 0 },
  },
};

export const webhookBodySchema = {
  type: 'object',
  required: ['name', 'url'],
  properties: {
    name: { type: 'string' },
    url: { type: 'string', format: 'url' },
  },
};
