const { Pool } = require('pg');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { stringify } = require('csv-stringify/sync');

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

// Export order = load order: tables other tables reference (via FK) come first.
const TABLES = [
  {
    name: 'customers',
    orderBy: 'customer_id',
    description: 'Customer master list (name + normalized name for fuzzy matching).',
    references: [],
  },
  {
    name: 'products',
    orderBy: 'model',
    description: 'Product/model catalogue (warranty months, product type).',
    references: [],
  },
  {
    name: 'knowledge_base',
    orderBy: 'id',
    description: 'Support knowledge base entries.',
    references: ['products.model -> knowledge_base.product_model'],
  },
  {
    name: 'policies',
    orderBy: 'policy_id',
    description: 'Company policy/procedure reference entries.',
    references: [],
  },
  {
    name: 'repair_jobs',
    orderBy: 'job_number',
    description: 'Repair job records (NetSuite-sourced).',
    references: [
      'products.model -> repair_jobs.product_model',
      'customers.customer_id -> repair_jobs.customer_id',
    ],
  },
  {
    name: 'daily_connote',
    orderBy: 'id',
    description: 'Daily courier connote log (incoming parcels).',
    references: ['customers.customer_id -> daily_connote.customer_id'],
  },
  {
    name: 'receipts',
    orderBy: 'id',
    description: 'Customer purchase receipts (extracted from photos via Bedrock vision).',
    references: [],
  },
];

async function exportTable(table) {
  const { rows } = await pool.query(`SELECT * FROM ${table.name} ORDER BY ${table.orderBy}`);
  const csv = stringify(rows, { header: true });
  return { rows, csv };
}

function buildReadme(exportedAt, results) {
  const lines = [
    '# Database Handover Export',
    '',
    `Exported: ${exportedAt}`,
    'Source: Aurora PostgreSQL cluster `tech-enquiry-aurora` (database `enquiries`)',
    '',
    '## How to restore',
    '',
    '1. Provision the schema first - run the `tech-enquiry-db-restore` Lambda (or the `createSchema()` function in `lambdas/db-restore/index.js`) against the target database. It creates all tables/indexes with `CREATE TABLE IF NOT EXISTS`.',
    '2. Load each CSV below into its matching table, in the order listed (parent tables before the tables that reference them via foreign key).',
    '3. Column headers in each CSV match the table columns exactly - a plain `COPY <table> FROM CSV HEADER` or psql `\\copy` works directly.',
    '',
    '## Tables (load in this order)',
    '',
  ];

  for (const r of results) {
    lines.push(`### ${r.table}`);
    lines.push('');
    lines.push(`- File: \`${r.table}.csv\``);
    lines.push(`- Rows: ${r.rowCount}`);
    lines.push(`- Description: ${r.description}`);
    lines.push(`- Foreign keys: ${r.references.length ? r.references.join('; ') : 'none'}`);
    lines.push('');
  }

  lines.push('## Not included in this export');
  lines.push('');
  lines.push('- Raw source files (SharePoint Excel exports, NetSuite/customer/connote CSVs) under `raw/` and `uploads/` in the `tech-enquiry-historical-docs-prod` S3 bucket - excluded by request.');
  lines.push('- Secrets (DB password, SharePoint app credentials, Bedrock model access) - handed over separately, not via this export.');
  lines.push('');

  return lines.join('\n');
}

exports.handler = async () => {
  const bucket = process.env.S3_BUCKET;
  const prefix = process.env.EXPORT_PREFIX || 'database/handover_export';
  const exportedAt = new Date().toISOString();

  const results = [];
  for (const table of TABLES) {
    console.log(`Exporting ${table.name}...`);
    const { rows, csv } = await exportTable(table);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}/${table.name}.csv`,
      Body: csv,
      ContentType: 'text/csv',
    }));
    console.log(`  -> s3://${bucket}/${prefix}/${table.name}.csv (${rows.length} rows)`);
    results.push({
      table: table.name,
      rowCount: rows.length,
      description: table.description,
      references: table.references,
    });
  }

  const readme = buildReadme(exportedAt, results);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${prefix}/README.md`,
    Body: readme,
    ContentType: 'text/markdown',
  }));

  await pool.end();

  return {
    statusCode: 200,
    exportedAt,
    bucket,
    prefix,
    tables: results,
  };
};
