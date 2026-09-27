import express from 'express';
import cors from 'cors';
import { connectDB, PORT, CLIENT_ORIGIN } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import productsRouter from './routes/products.js';
import customersRouter from './routes/customers.js';
import ordersRouter from './routes/orders.js';
import billsRouter from './routes/bills.js';
import dashboardRouter from './routes/dashboard.js';

const app = express();

app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/products', productsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/bills', billsRouter);
app.use('/api/dashboard', dashboardRouter);

app.use(notFoundHandler);
app.use(errorHandler);

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
  });
});
