import { ApiError } from '../utils/ApiError.js';

export function notFoundHandler(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  if (err?.name === 'CastError') {
    return res.status(400).json({ error: `Invalid value for "${err.path}".` });
  }
  if (err?.code === 11000) {
    const field = Object.keys(err.keyValue || { field: 1 })[0];
    return res.status(409).json({ error: `A record with this ${field} already exists.` });
  }
  if (err?.name === 'ValidationError') {
    const msg = Object.values(err.errors || {}).map((e) => e.message).join(' ');
    return res.status(400).json({ error: msg || 'Validation failed.' });
  }
  console.error('[error]', err);
  return res.status(500).json({ error: 'Internal server error.' });
}
