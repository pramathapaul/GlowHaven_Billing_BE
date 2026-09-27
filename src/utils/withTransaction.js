import mongoose from 'mongoose';
import { ApiError } from './ApiError.js';

/**
 * Runs `fn(session)` inside a MongoDB multi-document transaction so that
 * stock counts and their related documents are always written atomically.
 * Requires a replica set (Atlas counts).
 */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    throw translateTransactionError(err);
  } finally {
    await session.endSession();
  }
}

function translateTransactionError(err) {
  if (err instanceof ApiError) return err;
  const msg = String(err?.message || '');
  if (
    msg.includes('Transaction numbers are only allowed') ||
    msg.includes('replica set member or mongos') ||
    err?.codeName === 'IllegalOperation'
  ) {
    return new ApiError(
      503,
      'MongoDB does not support transactions on this connection. ' +
        'MONGODB_URI must point at a replica set (MongoDB Atlas clusters are replica sets by default).'
    );
  }
  return err;
}
