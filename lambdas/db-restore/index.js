const { Pool } = require('pg');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parse } = require('csv-parse/sync');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max:      2,
  connectionTimeoutMillis: 30000,
});

async function readCsvFromS3(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const content = await res.Body.transformToString('utf8');
  return parse(content, { columns: true, skip_empty_lines: true, relax_quotes: true, trim: true });
}

async function ensureProductsExist(client, records, modelColumn) {
  const uniqueModels = [...new Set(
    records.map(r => r[modelColumn]?.trim().toUpperCase()).filter(Boolean)
  )];
  for (const model of uniqueModels) {
    await client.query(
      `INSERT INTO products (model, warranty_month) VALUES ($1, 0) ON CONFLICT (model) DO NOTHING`,
      [model]
    );
  }
}

async function seedProducts(bucket) {
  console.log('Seeding products...');
  const records = await readCsvFromS3(bucket, 'database/product_data.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of records) {
      await client.query(
        `INSERT INTO products (model, product_name, description, warranty_month, product_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (model) DO UPDATE SET
           product_name   = EXCLUDED.product_name,
           description    = EXCLUDED.description,
           warranty_month = EXCLUDED.warranty_month`,
        [
          row.model?.trim().toUpperCase(),
          row.product_name?.trim(),
          row.description?.trim(),
          parseInt(row.warranty_month) || null,
          row.product_type?.trim(),
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} products`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedKnowledgeBase(bucket) {
  console.log('Seeding knowledge_base...');
  const records = await readCsvFromS3(bucket, 'database/knowledge_base.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureProductsExist(client, records, 'product_model');
    for (const row of records) {
      await client.query(
        `INSERT INTO knowledge_base (id, product_model, entry_type, question, answer, source_file, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           product_model = EXCLUDED.product_model,
           question      = EXCLUDED.question,
           answer        = EXCLUDED.answer`,
        [
          parseInt(row.id),
          row.product_model?.trim().toUpperCase() || null,
          row.entry_type?.trim(),
          row.question?.trim(),
          row.answer?.trim(),
          row.source_file?.trim(),
          row.created_at || null,
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} knowledge_base entries`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedCustomers(bucket) {
  console.log('Seeding customers...');
  let records;
  try {
    records = await readCsvFromS3(bucket, 'database/customers.csv');
  } catch (err) {
    console.log('  No customers.csv found, skipping.');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of records) {
      const customerId = parseInt(row.customer_id);
      const customerName = row.customer_name?.trim();
      if (!customerId || !customerName) continue;
      const cleanEmail = row.email?.trim().toLowerCase() || null;
      await client.query(
        `INSERT INTO customers (customer_id, customer_name, customer_name_norm, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (customer_id) DO UPDATE SET
           customer_name      = EXCLUDED.customer_name,
           customer_name_norm = EXCLUDED.customer_name_norm,
           email              = EXCLUDED.email`,
        [customerId, customerName, row.customer_name_norm?.trim() || normalise(customerName), cleanEmail]
      );
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} customers`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function normalise(text) {
  return text ? text.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

function parseCustomerField(raw) {
  if (!raw) return { customerId: null, customerName: null };
  const match = raw.trim().match(/^(\d+)\s+#?(.+)$/);
  if (!match) return { customerId: null, customerName: raw.trim() };
  return { customerId: parseInt(match[1]), customerName: match[2].trim() };
}

async function seedRepairJobs(bucket) {
  console.log('Seeding repair_jobs...');
  const records = await readCsvFromS3(bucket, 'database/repair_data.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureProductsExist(client, records, 'product_model');
    const BATCH_SIZE = 500;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        const { customerId, customerName } = parseCustomerField(row.customer_name);
        await client.query(
          `INSERT INTO repair_jobs (job_number, product_model, customer_comment, customer_name, customer_id, date_opened, job_action, technician_comment, serial_number, replacement_serial_number, date_closed, status, stage, reference)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (job_number) DO UPDATE SET
             serial_number = EXCLUDED.serial_number,
             replacement_serial_number = EXCLUDED.replacement_serial_number,
             technician_comment = EXCLUDED.technician_comment,
             date_closed = EXCLUDED.date_closed,
             status = EXCLUDED.status,
             stage = EXCLUDED.stage,
             customer_id = EXCLUDED.customer_id,
             customer_name = EXCLUDED.customer_name,
             reference = EXCLUDED.reference`,
          [
            row.job_number?.trim(),
            row.product_model?.trim().toUpperCase() || null,
            row.customer_comment?.trim(),
            customerName || null,
            customerId || null,
            row.date_opened || null,
            row.job_action?.trim(),
            row.technician_comment?.trim(),
            row.serial_number?.trim() || null,
            row.replacement_serial_number?.trim() || null,
            row.date_closed || null,
            row.status?.trim() || null,
            row.stage?.trim() || null,
            row.reference?.trim() || null,
          ]
        );
      }
      console.log(`  ... ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`);
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} repair jobs`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedPolicies(bucket) {
  console.log('Seeding policies...');
  const records = await readCsvFromS3(bucket, 'database/company_policy.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of records) {
      await client.query(
        `INSERT INTO policies (policy_id, category, procedure_title, details, applicable_fees, timeframe, contact_info, source_file)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (policy_id) DO UPDATE SET
           details         = EXCLUDED.details,
           procedure_title = EXCLUDED.procedure_title`,
        [
          row['Policy ID']?.trim(),
          row['Category']?.trim(),
          row['Policy / Procedure']?.trim(),
          row['Details / Rules']?.trim(),
          row['Applicable Fees']?.trim(),
          row['Timeframe']?.trim(),
          row['Contact / Action Required']?.trim(),
          row['Source Document']?.trim(),
        ]
      );
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} policies`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedConnote(bucket) {
  console.log('Seeding daily_connote...');
  let records;
  try {
    records = await readCsvFromS3(bucket, 'database/daily_connote.csv');
  } catch (err) {
    console.log('  No daily_connote.csv found, skipping.');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE daily_connote RESTART IDENTITY');
    for (const row of records) {
      await client.query(
        `INSERT INTO daily_connote (date_received, courier, tracking, reference, sender, sender_norm, received_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          row.date_received || null,
          row.courier?.trim() || null,
          row.tracking?.trim() || null,
          row.reference?.trim() || null,
          row.sender?.trim() || null,
          row.sender_norm?.trim() || normalise(row.sender),
          row.received_by?.trim() || null,
        ]
      );
    }

    // Match sender_norm to customer_name_norm — pick longest customer name that is a prefix of sender_norm
    await client.query(`
      UPDATE daily_connote dc
      SET customer_id = best.customer_id
      FROM (
        SELECT DISTINCT ON (dc.id)
          dc.id,
          c.customer_id,
          length(c.customer_name_norm) AS match_len
        FROM daily_connote dc
        JOIN customers c ON dc.sender_norm LIKE c.customer_name_norm || '%'
        WHERE length(c.customer_name_norm) >= 5
        ORDER BY dc.id, match_len DESC
      ) best
      WHERE dc.id = best.id
    `);

    const matched = await client.query(`SELECT COUNT(*) FROM daily_connote WHERE customer_id IS NOT NULL`);
    console.log(`  ✓ ${records.length} connote entries, ${matched.rows[0].count} matched to a customer`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function seedDiscontinuedProducts(bucket) {
  console.log('Seeding discontinued products...');
  const records = await readCsvFromS3(bucket, 'database/discontinued_products.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let updated = 0, inserted = 0;
    for (const row of records) {
      const model = row['Model / Product Name']?.trim().toUpperCase();
      const productName = row['Model / Product Name']?.trim() || null;
      const productType = row['Sub-Type']?.trim() || null;
      const description = row['Category']?.trim() || null;
      if (!model) continue;

      const res = await client.query(
        `UPDATE products SET
           status       = 'Discontinued',
           product_name = COALESCE(NULLIF(product_name, ''), $2),
           product_type = COALESCE(NULLIF(product_type, ''), $3),
           description  = COALESCE(NULLIF(description,  ''), $4)
         WHERE UPPER(model) = $1`,
        [model, productName, productType, description]
      );
      if (res.rowCount > 0) {
        updated++;
      } else {
        await client.query(
          `INSERT INTO products (model, product_name, product_type, description, warranty_month, status)
           VALUES ($1, $2, $3, $4, 0, 'Discontinued')
           ON CONFLICT (model) DO NOTHING`,
          [model, productName, productType, description]
        );
        inserted++;
      }
    }
    await client.query('COMMIT');
    console.log(`  ✓ ${updated} updated, ${inserted} new discontinued stubs`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createSchema() {
  console.log('Creating tables if not exists...');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        customer_id        INTEGER PRIMARY KEY,
        customer_name      TEXT NOT NULL,
        customer_name_norm TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(LOWER(customer_name));
    `);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_name_norm TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_name_norm ON customers(customer_name_norm)`);
    await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(LOWER(email))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        model          VARCHAR(100) PRIMARY KEY,
        product_name   TEXT,
        description    TEXT,
        warranty_month INTEGER,
        product_type   VARCHAR(100),
        status         VARCHAR(50)
      );

      CREATE TABLE IF NOT EXISTS knowledge_base (
        id            SERIAL PRIMARY KEY,
        product_model VARCHAR(100) REFERENCES products(model) ON DELETE SET NULL,
        entry_type    VARCHAR(50),
        question      TEXT,
        answer        TEXT,
        source_file   VARCHAR(255),
        created_at    DATE
      );
      CREATE INDEX IF NOT EXISTS idx_kb_product_model ON knowledge_base(product_model);

      CREATE TABLE IF NOT EXISTS repair_jobs (
        job_number                VARCHAR(50) PRIMARY KEY,
        product_model             VARCHAR(100) REFERENCES products(model) ON DELETE SET NULL,
        customer_comment          TEXT,
        customer_name             TEXT,
        date_opened               TIMESTAMP,
        job_action                VARCHAR(100),
        technician_comment        TEXT,
        serial_number             VARCHAR(100),
        replacement_serial_number VARCHAR(100),
        date_closed               TIMESTAMP,
        status                    VARCHAR(100),
        stage                     VARCHAR(100)
      );
      CREATE INDEX IF NOT EXISTS idx_repair_jobs_product_model ON repair_jobs(product_model);
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100);
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS replacement_serial_number VARCHAR(100);
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS date_closed TIMESTAMP;
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS status VARCHAR(100);
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS stage VARCHAR(100);
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS customer_id INTEGER;
      ALTER TABLE repair_jobs ADD COLUMN IF NOT EXISTS reference VARCHAR(200);
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_repair_jobs_customer ON repair_jobs(customer_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS policies (
        policy_id       VARCHAR(20) PRIMARY KEY,
        category        VARCHAR(100),
        procedure_title TEXT,
        details         TEXT,
        applicable_fees TEXT,
        timeframe       TEXT,
        contact_info    TEXT,
        source_file     VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);

      CREATE TABLE IF NOT EXISTS daily_connote (
        id           SERIAL PRIMARY KEY,
        date_received DATE,
        courier      VARCHAR(100),
        tracking     VARCHAR(500),
        reference    VARCHAR(200),
        sender       VARCHAR(200),
        received_by  VARCHAR(100)
      );
      CREATE INDEX IF NOT EXISTS idx_connote_sender   ON daily_connote(LOWER(sender));
      CREATE INDEX IF NOT EXISTS idx_connote_tracking ON daily_connote(tracking);
      CREATE INDEX IF NOT EXISTS idx_connote_reference ON daily_connote(reference);
      CREATE INDEX IF NOT EXISTS idx_connote_date     ON daily_connote(date_received);
    `);
    await client.query(`ALTER TABLE daily_connote ADD COLUMN IF NOT EXISTS customer_id INTEGER`);
    await client.query(`ALTER TABLE daily_connote ADD COLUMN IF NOT EXISTS sender_norm TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_connote_customer    ON daily_connote(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_connote_sender_norm ON daily_connote(sender_norm)`);
    await client.query(`

      CREATE TABLE IF NOT EXISTS receipts (
        id             SERIAL PRIMARY KEY,
        store_name     VARCHAR(200),
        customer_name  VARCHAR(200),
        product_name   TEXT,
        model_number   VARCHAR(100),
        purchase_date  DATE,
        total_price    DECIMAL(10,2),
        receipt_number VARCHAR(100),
        date_uploaded  TIMESTAMP DEFAULT NOW(),
        uploaded_by    VARCHAR(200)
      );
      CREATE INDEX IF NOT EXISTS idx_receipts_customer ON receipts(LOWER(customer_name));
      CREATE INDEX IF NOT EXISTS idx_receipts_model    ON receipts(LOWER(model_number));
    `);
    // pg_trgm fuzzy name search
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_name_norm_trgm ON customers USING GIN (customer_name_norm gin_trgm_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_connote_sender_trgm ON daily_connote USING GIN (sender gin_trgm_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_repair_jobs_customer_name_trgm ON repair_jobs USING GIN (customer_name gin_trgm_ops)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_model_trgm ON products USING GIN (model gin_trgm_ops)`);

    console.log('  ✓ Schema ready');
  } finally {
    client.release();
  }
}

exports.handler = async (event) => {
  const bucket = event.bucket || process.env.S3_BUCKET;
  const tables = event.tables || null; // null = full restore; ['repair_jobs'] = targeted seed
  const fullRestore = !tables;

  if (fullRestore) {
    console.log(`Full restore from s3://${bucket}/database/...`);
  } else {
    console.log(`Targeted seed from s3://${bucket}/database/... tables=${tables.join(',')}`);
  }

  await createSchema();

  if (fullRestore || tables.includes('customers'))         await seedCustomers(bucket);
  if (fullRestore || tables.includes('products'))          await seedProducts(bucket);
  if (fullRestore || tables.includes('knowledge_base'))    await seedKnowledgeBase(bucket);
  if (fullRestore || tables.includes('repair_jobs'))       await seedRepairJobs(bucket);
  if (fullRestore || tables.includes('policies'))          await seedPolicies(bucket);
  if (fullRestore || tables.includes('discontinued'))      await seedDiscontinuedProducts(bucket);
  if (fullRestore || tables.includes('connote'))           await seedConnote(bucket);

  console.log('Done! All tables seeded.');
  return { statusCode: 200, body: 'Seeded successfully' };
};
