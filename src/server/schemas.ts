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
  },
  minProperties: 1,
};

export const webhookBodySchema = {
  type: 'object',
  required: ['name', 'url'],
  properties: {
    name: { type: 'string' },
    url: { type: 'string', format: 'url' },
  },
};
