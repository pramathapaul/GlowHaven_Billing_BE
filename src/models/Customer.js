import mongoose from 'mongoose';
import { jsonOptions } from './schemaOptions.js';

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Customer name is required.'], trim: true, maxlength: 200 },
    phone: { type: String, required: [true, 'Phone is required.'], trim: true, maxlength: 30 },
    phone2: { type: String, default: null, trim: true, maxlength: 30 },
    email: { type: String, default: null, trim: true, lowercase: true, maxlength: 200 },
    address: { type: String, default: null, trim: true, maxlength: 500 },
  },
  jsonOptions()
);

export const Customer = mongoose.model('Customer', customerSchema);
