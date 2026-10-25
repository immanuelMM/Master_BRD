const crypto = require('crypto');
const mailer = require('../notifications/mailer');

async function requestPasswordReset(db, email) {
  const user = await db.users.findByEmail(email);
  if (!user) return; // do not reveal whether the account exists
  const token = crypto.randomBytes(32).toString('hex');
  await db.resetTokens.insert({ userId: user.id, token, expiresAt: Date.now() + 60 * 60 * 1000 });
  await mailer.send(user.email, 'Reset your password', `https://portal.example.com/reset?token=${token}`);
}

module.exports = { requestPasswordReset };
