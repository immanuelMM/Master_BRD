const bcrypt = require('bcrypt');
const MAX_FAILED_ATTEMPTS = 5;

async function login(db, email, password) {
  const user = await db.users.findByEmail(email);
  if (!user) throw new Error('Invalid credentials');
  if (user.locked) throw new Error('Account locked');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedAttempts += 1;
    if (user.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      user.locked = true;
    }
    await db.users.save(user);
    throw new Error('Invalid credentials');
  }
  user.failedAttempts = 0;
  await db.users.save(user);
  return issueSession(user);
}

// TODO: two-factor authentication (not started)
function verifyOtp(user, code) {
  throw new Error('Not implemented');
}

function issueSession(user) {
  return { userId: user.id, role: user.role, issuedAt: Date.now() };
}

module.exports = { login, verifyOtp };
