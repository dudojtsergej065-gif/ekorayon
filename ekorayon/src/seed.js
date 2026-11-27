require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
(async () => {
  try {
    const email = process.env.ADMIN_EMAIL || 'admin@example.org';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe_2026!';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(`INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(email) DO NOTHING`, [process.env.ADMIN_NAME || 'Главный администратор', email, hash]);
    console.log(`Admin account ready: ${email}. Set a unique ADMIN_PASSWORD before deployment.`);
  } catch (e) { console.error(e); process.exitCode = 1; }
  finally { await pool.end(); }
})();
