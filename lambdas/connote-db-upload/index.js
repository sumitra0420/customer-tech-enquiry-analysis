const { Pool } = require('pg');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
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

function normalise(text) {
  return text ? text.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
}

function toCSV(rows, includeHeader = true) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString().split('T')[0] : String(v);
    return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = includeHeader ? [headers.join(',')] : [];
  for (const row of rows) lines.push(headers.map(h => escape(row[h])).join(','));
  return lines.join('\n');
}

exports.handler = async (event) => {
  const bucket = event.Records[0].s3.bucket.name;
  const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));

  console.log(`Processing: s3://${bucket}/${key}`);

  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const content = await res.Body.transformToString('utf8');
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  console.log(`  ${records.length} rows in CSV`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;
    const insertedIds = [];

    for (const row of records) {
      const tracking = row.tracking?.trim() || null;
      if (!tracking) { skipped++; continue; }

      const reference = row.reference?.trim() || null;
      const sender = row.sender?.trim() || null;

      // Check if this exact row already exists before inserting
      const exists = await client.query(
        `SELECT 1 FROM daily_connote WHERE tracking = $1 AND reference IS NOT DISTINCT FROM $2 AND sender IS NOT DISTINCT FROM $3 LIMIT 1`,
        [tracking, reference, sender]
      );
      if (exists.rowCount > 0) { skipped++; continue; }

      const result = await client.query(
        `INSERT INTO daily_connote (date_received, courier, tracking, reference, sender, sender_norm, received_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          row.received_date || null,
          row.courier?.trim() || null,
          tracking,
          reference,
          sender,
          row.sender_norm?.trim() || normalise(row.sender),
          row.received_by?.trim() || null,
        ]
      );
      if (result.rowCount > 0) { inserted++; insertedIds.push(result.rows[0].id); }
      else skipped++;
    }

    // Match newly inserted unmatched rows to customers
    const matchResult = await client.query(`
      UPDATE daily_connote dc
      SET customer_id = best.customer_id
      FROM (
        SELECT DISTINCT ON (dc.id)
          dc.id,
          c.customer_id,
          length(c.customer_name_norm) AS match_len
        FROM daily_connote dc
        JOIN customers c ON dc.sender_norm LIKE c.customer_name_norm || '%'
        WHERE dc.customer_id IS NULL
          AND length(c.customer_name_norm) >= 5
        ORDER BY dc.id, match_len DESC
      ) best
      WHERE dc.id = best.id
    `);
    const customerMatched = matchResult.rowCount;

    // Total records in database after insert
    const totalResult = await client.query(`SELECT COUNT(*) FROM daily_connote`);
    const totalRecords = parseInt(totalResult.rows[0].count);

    // Unmatched records (no customer linked)
    const unmatchedResult = await client.query(`SELECT COUNT(*) FROM daily_connote WHERE customer_id IS NULL`);
    const unmatchedRecords = parseInt(unmatchedResult.rows[0].count);

    await client.query('COMMIT');

    // Append only newly inserted rows to the S3 snapshot — faster than full export
    if (insertedIds.length > 0) {
      // Fetch final state of inserted rows (customer_id now populated by the UPDATE above)
      const newRowsResult = await client.query(
        `SELECT id, date_received, courier, tracking, reference, sender, sender_norm, received_by, customer_id
         FROM daily_connote WHERE id = ANY($1) ORDER BY id`,
        [insertedIds]
      );

      // Download existing CSV (start fresh if the file doesn't exist yet)
      let existingCsv = '';
      try {
        const existing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'database/daily_connote.csv' }));
        existingCsv = await existing.Body.transformToString('utf8');
      } catch (err) {
        if (err.name !== 'NoSuchKey') throw err;
      }

      // Append new rows — include header only if the file is being created for the first time
      const newLines = toCSV(newRowsResult.rows, !existingCsv);
      const updatedCsv = existingCsv ? existingCsv.trimEnd() + '\n' + newLines : newLines;

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: 'database/daily_connote.csv',
        Body: updatedCsv,
        ContentType: 'text/csv',
      }));
    }

    console.log(`--- connote-db-upload summary ---`);
    console.log(`  CSV rows:           ${records.length}`);
    console.log(`  Inserted (new):     ${inserted}`);
    console.log(`  Skipped (existing): ${skipped}`);
    console.log(`  Customer matched:   ${customerMatched}`);
    console.log(`  Total in DB:        ${totalRecords}`);
    console.log(`  Unmatched senders:  ${unmatchedRecords}`);
    console.log(`  S3 backup:          +${insertedIds.length} rows appended → database/daily_connote.csv`);
    console.log(`---------------------------------`);

    return { statusCode: 200, body: JSON.stringify({ inserted, skipped, customerMatched, totalRecords, unmatchedRecords }) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
