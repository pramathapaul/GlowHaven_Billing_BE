import { validationResult } from 'express-validator';

export function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  const errors = result.array().map((e) => e.msg);
  return res.status(400).json({ error: [...new Set(errors)].join(' '), details: errors });
}
