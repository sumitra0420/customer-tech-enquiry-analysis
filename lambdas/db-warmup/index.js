const { Pool } = require('pg');

// Small connection pool — only need 1 connection just to wake Aurora
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max:      1,
  connectionTimeoutMillis: 10000, // wait up to 10s for Aurora to wake
});

exports.handler = async (event) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1'); // lightest possible query — just opens the connection
    client.release();
    console.log('Aurora warmed up successfully for user:', event.userName);
  } catch (err) {
    // IMPORTANT: we catch the error but do NOT rethrow it.
    // If warmup fails, the user can still log in — we never block login for a DB issue.
    console.error('DB warmup failed (non-fatal):', err.message);
  }

  // MUST return the event unchanged — this is required by ALL Cognito Lambda triggers.
  // If you don't return the event, Cognito treats it as an error and blocks the login.
  return event;
};
