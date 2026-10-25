const nodemailer = require('nodemailer');
const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: 587 });

async function send(to, subject, body) {
  return transport.sendMail({ from: 'no-reply@portal.example.com', to, subject, text: body });
}

module.exports = { send };
