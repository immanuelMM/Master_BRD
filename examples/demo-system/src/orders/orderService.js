const CANCEL_WINDOW_HOURS = 48;
const PAGE_SIZE = 20;

async function placeOrder(db, customerId, items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Order must contain at least one product');
  const order = { customerId, items, status: 'PLACED', placedAt: Date.now() };
  return db.orders.insert(order);
}

async function cancelOrder(db, orderId) {
  const order = await db.orders.get(orderId);
  const hours = (Date.now() - order.placedAt) / 3600000;
  if (hours > CANCEL_WINDOW_HOURS) throw new Error('Cancellation window has passed');
  order.status = 'CANCELLED';
  return db.orders.save(order);
}

async function orderHistory(db, customerId, page = 1) {
  return db.orders.find({ customerId }, { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, sort: { placedAt: -1 } });
}

module.exports = { placeOrder, cancelOrder, orderHistory };
