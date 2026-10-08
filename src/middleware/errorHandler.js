const { ZodError } = require('zod');
const { AppError } = require('../errors');

function notFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
  }
  console.error(err);
  return res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}

module.exports = { notFound, errorHandler };
