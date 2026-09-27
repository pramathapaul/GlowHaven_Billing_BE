import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

export const ORDER_STATUSES = ['draft', 'confirmed', 'billed', 'cancelled'];

const orderSchema = new mongoose.Schema(
  {
    customer_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: [true, 'Customer is required.'],
    },
    status: { type: String, enum: ORDER_STATUSES, default: 'draft' },
    created_at: { type: Date, default: Date.now },
  },
  jsonOptions()
);

export const Order = mongoose.model('Order', orderSchema);
