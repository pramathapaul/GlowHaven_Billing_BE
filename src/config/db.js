import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

export const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
export const PORT = Number(process.env.PORT || 5000);
export const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD || 5);
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
// UPI payment QR on the 58mm thermal receipt.
//   UPI_ID   – payee VPA (e.g. glowhaven@upi). Empty ⇒ QR is omitted.
//   UPI_NAME – payee display name shown in UPI apps (defaults to GlowHaven).
export const UPI_ID = (process.env.UPI_ID || '').trim();
export const UPI_NAME = (process.env.UPI_NAME || 'GlowHaven').trim() || 'GlowHaven';

export async function connectDB() {
  if (!MONGODB_URI) {
    console.error(
      '\n[db] MONGODB_URI is not set.\n' +
        '     1) Copy server/.env.example to server/.env\n' +
        '     2) Set MONGODB_URI to your MongoDB connection string (replica set required, e.g. Atlas)\n'
    );
    process.exit(1);
  }
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('[db] connected:', maskUri(MONGODB_URI));
  } catch (err) {
    console.error('[db] connection failed:', err.message);
    process.exit(1);
  }
}

function maskUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
}
