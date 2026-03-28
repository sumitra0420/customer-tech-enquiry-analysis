const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ─── Database connection ───────────────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'enquiries',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

const CSV_DIR = path.join(__dirname, '../s3-data/database');

// ─── Helper ────────────────────────────────────────────────────────────────────
function readCsv(filename) {
  const content = fs.readFileSync(path.join(CSV_DIR, filename), 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  });
}

// Pre-insert any product models that don't exist in products table yet
// Prevents FK violation when seeding child tables
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

// ─── 1. Seed products (must run first — other tables reference it) ─────────────
async function seedProducts() {
  console.log('Seeding products...');
  const records = readCsv('product_data.csv');
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
           warranty_month = EXCLUDED.warranty_month,
           product_type   = EXCLUDED.product_type`,
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
    console.log(`  ✓ ${records.length} products inserted`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── 2. Seed knowledge_base ────────────────────────────────────────────────────
async function seedKnowledgeBase() {
  console.log('Seeding knowledge_base...');
  const records = readCsv('knowledge_base.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pre-insert any missing product models to avoid FK violation
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
    console.log(`  ✓ ${records.length} knowledge_base entries inserted`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── 3. Seed repair_jobs ───────────────────────────────────────────────────────
async function seedRepairJobs() {
  console.log('Seeding repair_jobs...');
  const records = readCsv('repair_data.csv');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Pre-insert any missing product models to avoid FK violation
    await ensureProductsExist(client, records, 'product_model');

    // Insert repair jobs in batches of 500
    const BATCH_SIZE = 500;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      for (const row of batch) {
        await client.query(
          `INSERT INTO repair_jobs (job_number, product_model, customer_comment, customer_name, date_opened, job_action, technician_comment)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (job_number) DO NOTHING`,
          [
            row.job_number?.trim(),
            row.product_model?.trim().toUpperCase() || null,
            row.customer_comment?.trim(),
            row.customer_name?.trim(),
            row.date_opened || null,
            row.job_action?.trim(),
            row.technician_comment?.trim(),
          ]
        );
      }
      console.log(`  ... ${Math.min(i + BATCH_SIZE, records.length)}/${records.length}`);
    }

    await client.query('COMMIT');
    console.log(`  ✓ ${records.length} repair jobs inserted`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── 4. Seed policies ──────────────────────────────────────────────────────────
async function seedPolicies() {
  console.log('Seeding policies...');
  const records = readCsv('company_policy.csv');
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
    console.log(`  ✓ ${records.length} policies inserted`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Connecting to ${pool.options.host}:${pool.options.port}/${pool.options.database}...\n`);
  try {
    await seedProducts();
    await seedKnowledgeBase();
    await seedRepairJobs();
    await seedPolicies();
    console.log('\nDone! All data seeded successfully.');
  } catch (err) {
    console.error('\nSeeding failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
