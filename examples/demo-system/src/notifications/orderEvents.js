const mailer = require('./mailer');
// const sms = require('./sms');

async function onOrderShipped(order, customer) {
  await mailer.send(customer.email, 'Your order has shipped', `Order ${order.id} is on its way.`);
}

async function onOutForDelivery(order, customer) {
  // await sms.send(customer.phone, `Order ${order.id} is out for delivery`);
}

module.exports = { onOrderShipped, onOutForDelivery };
