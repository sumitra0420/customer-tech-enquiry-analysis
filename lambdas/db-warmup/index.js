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
  connectionTimeoutMillis: 55000, // wait up to 55s for Aurora cold start
});

exports.handler = async (event) => {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('Aurora warmed up successfully');
  } catch (err) {
    console.error('DB warmup failed:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'warmup failed',
    };
  }

  // API Gateway HTTP response
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: 'ok',
  };
};
