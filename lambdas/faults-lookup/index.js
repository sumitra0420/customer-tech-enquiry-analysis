const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { Pool } = require('pg');

const bedrockClient = new BedrockRuntimeClient({
  region: 'ap-southeast-2',
  maxAttempts: 5,
  retryMode: 'adaptive',
});

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'enquiries',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json',
};

const FAULT_SAMPLE_LIMIT = 1000;
const RECENT_JOBS_LIMIT = 100;
const TREND_MONTHS = 18;
const SD_CARD_WARNING_THRESHOLD = 0.10;
const OUTCOME_BUCKETS = ['Unable to Confirm Fault', 'Fault Confirmed', 'Firmware Update Fixed It', 'SD Card Issue', 'Other'];

// ─── Shared Bedrock call (with retry on throttling) ───────────────────────────
async function callBedrock(prompt, maxTokens = 2000) {
  const response = await bedrockClient.send(new InvokeModelCommand({
    modelId: process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  }));
  const body = JSON.parse(new TextDecoder().decode(response.body));
  return body.content[0].text;
}

function parseJsonFromBedrock(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(stripped);
}

// ─── Model search (autocomplete) — pure SQL, no Bedrock ───────────────────────
async function findModelMatches(query, limit = 8) {
  const upper = query.trim().toUpperCase();
  const { rows } = await pool.query(
    `SELECT model, product_name, product_type
     FROM products
     WHERE similarity(model, $1) > 0.25
        OR word_similarity($1, model) > 0.4
        OR model ILIKE $2
     ORDER BY GREATEST(similarity(model, $1), word_similarity($1, model)) DESC
     LIMIT $3`,
    [upper, `%${upper}%`, limit]
  );
  return rows;
}

async function resolveModel(rawModel) {
  const upper = rawModel.trim().toUpperCase();
  const exact = await pool.query(`SELECT model FROM products WHERE UPPER(model) = $1 LIMIT 1`, [upper]);
  if (exact.rows.length > 0) return exact.rows[0].model;

  const fuzzy = await findModelMatches(upper, 1);
  return fuzzy.length > 0 ? fuzzy[0].model : null;
}

// ─── Deterministic SQL aggregations ───────────────────────────────────────────
async function queryKpis(model) {
  const [modelCount, allCount, dateRange, mostRecent] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS count FROM repair_jobs WHERE product_model = $1`, [model]),
    pool.query(`SELECT COUNT(*)::int AS count FROM repair_jobs`),
    pool.query(`SELECT MIN(date_opened) AS earliest, MAX(date_opened) AS latest FROM repair_jobs WHERE product_model = $1`, [model]),
    pool.query(
      `SELECT job_number, date_opened FROM repair_jobs WHERE product_model = $1 ORDER BY date_opened DESC LIMIT 1`,
      [model]
    ),
  ]);

  const totalJobs = modelCount.rows[0].count;
  const allModelsTotalJobs = allCount.rows[0].count;

  return {
    totalJobs,
    allModelsTotalJobs,
    sharePercent: allModelsTotalJobs > 0 ? Number(((totalJobs / allModelsTotalJobs) * 100).toFixed(1)) : 0,
    earliestDate: dateRange.rows[0].earliest,
    mostRecentDate: dateRange.rows[0].latest,
    mostRecentJobNumber: mostRecent.rows[0]?.job_number || null,
  };
}

async function queryTrend(model) {
  const { rows } = await pool.query(
    `SELECT date_trunc('month', date_opened) AS month, COUNT(*)::int AS count
     FROM repair_jobs
     WHERE product_model = $1 AND date_opened >= now() - interval '${TREND_MONTHS} months'
     GROUP BY 1
     ORDER BY 1`,
    [model]
  );

  const countsByMonth = new Map(rows.map(r => [r.month.toISOString().slice(0, 7), r.count]));

  const months = [];
  const counts = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - (TREND_MONTHS - 1));
  for (let i = 0; i < TREND_MONTHS; i++) {
    const key = cursor.toISOString().slice(0, 7);
    months.push(cursor.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }));
    counts.push(countsByMonth.get(key) || 0);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return { months, counts };
}

// Fetches up to `limit` jobs newest-first. The first RECENT_JOBS_LIMIT of these
// double as the "recent jobs" table, so the AI classification (over this same
// ordered list) can tag them individually without a second query or ordering drift.
async function querySampleJobs(model, limit = FAULT_SAMPLE_LIMIT) {
  const { rows } = await pool.query(
    `SELECT job_number, date_opened, customer_comment, technician_comment, job_action, status, stage
     FROM repair_jobs WHERE product_model = $1 ORDER BY date_opened DESC LIMIT $2`,
    [model, limit]
  );
  return rows;
}

async function queryProductInfo(model) {
  const { rows } = await pool.query(
    `SELECT product_name, description, warranty_month, product_type, status FROM products WHERE UPPER(model) = $1 LIMIT 1`,
    [model.toUpperCase()]
  );
  return rows[0] || null;
}

// ─── AI classification — one Bedrock call per search ──────────────────────────
// TASK 1 classifies the full sample (for accurate aggregate counts/chart data).
// TASK 2 additionally tags the first `recentCount` jobs individually (they are
// the newest-first head of the same list) so the jobs table can show a
// category/outcome badge per row and support the filter chips.
async function classifyFaults(model, sampleJobs, recentCount) {
  if (sampleJobs.length === 0) {
    return { faultCategories: [], technicianOutcomes: [], jobClassifications: [] };
  }

  const jobLines = sampleJobs.map(j =>
    `Job ${j.job_number} | Customer: "${(j.customer_comment || '').slice(0, 300)}" | Tech: "${(j.technician_comment || '').slice(0, 300)}"`
  ).join('\n');

  const prompt = `You are a data classification engine. Output ONLY valid JSON, no markdown, no prose, no code fences.

MODEL: ${model}
JOB DATA (${sampleJobs.length} jobs, ordered newest first):
${jobLines}

TASK 1: Classify all ${sampleJobs.length} jobs above into fault categories (the customer-reported issue type) and technician outcomes (what the technician found or did). Choose up to 7 fault category names that best summarise the data (fold minor/rare ones into "Other"). Use these outcome buckets EXACTLY as written: ${OUTCOME_BUCKETS.map(b => `"${b}"`).join(', ')}. Return count totals across all ${sampleJobs.length} jobs.

TASK 2: For ONLY the first ${recentCount} jobs listed above (the newest ones), return each job's individually assigned category and outcome.

Return ONLY this JSON shape:
{
  "faultCategories": [{"name": "Power Cycling / Restart", "count": 15}],
  "technicianOutcomes": [{"name": "Unable to Confirm Fault", "count": 32}],
  "jobClassifications": [{"jobNumber": "SC17326", "category": "Power Cycling / Restart", "outcome": "Fault Confirmed"}]
}
"jobClassifications" must contain exactly ${recentCount} entries, one per job number from the first ${recentCount} jobs listed above.`;

  try {
    const text = await callBedrock(prompt, 6000);
    const parsed = parseJsonFromBedrock(text);
    return {
      faultCategories: Array.isArray(parsed.faultCategories) ? parsed.faultCategories : [],
      technicianOutcomes: Array.isArray(parsed.technicianOutcomes) ? parsed.technicianOutcomes : [],
      jobClassifications: Array.isArray(parsed.jobClassifications) ? parsed.jobClassifications : [],
    };
  } catch (err) {
    console.error('Fault classification failed:', err.message);
    return { faultCategories: [], technicianOutcomes: [], jobClassifications: [] };
  }
}

function computeSdCardWarning(technicianOutcomes) {
  const total = technicianOutcomes.reduce((sum, o) => sum + (o.count || 0), 0);
  const sdCard = technicianOutcomes.find(o => o.name === 'SD Card Issue');
  const count = sdCard?.count || 0;
  const percentage = total > 0 ? count / total : 0;

  return {
    show: percentage > SD_CARD_WARNING_THRESHOLD,
    count,
    percentage: Number((percentage * 100).toFixed(1)),
  };
}

// ─── Route handlers ────────────────────────────────────────────────────────────
async function handleModelSearch(query) {
  if (!query || !query.trim()) return { results: [] };
  const rows = await findModelMatches(query);
  return {
    results: rows.map(r => ({ model: r.model, productName: r.product_name, productType: r.product_type })),
  };
}

async function handleFaultsDashboard(rawModel) {
  const model = await resolveModel(rawModel);
  if (!model) {
    return { error: 'not_found', message: `No product model found matching "${rawModel}"` };
  }

  const [kpis, trend, sampleJobs, productInfo] = await Promise.all([
    queryKpis(model),
    queryTrend(model),
    querySampleJobs(model, FAULT_SAMPLE_LIMIT),
    queryProductInfo(model),
  ]);

  const recentJobs = sampleJobs.slice(0, RECENT_JOBS_LIMIT);
  const { faultCategories, technicianOutcomes, jobClassifications } = await classifyFaults(model, sampleJobs, recentJobs.length);
  const sdCardWarning = computeSdCardWarning(technicianOutcomes);

  const classificationByJob = new Map(jobClassifications.map(c => [c.jobNumber, c]));

  return {
    model,
    productName: productInfo?.product_name || null,
    warrantyMonths: productInfo?.warranty_month || null,
    productType: productInfo?.product_type || null,
    status: productInfo?.status || 'Active',
    kpis,
    trend,
    faultCategories,
    technicianOutcomes,
    sdCardWarning,
    sampleInfo: {
      sampleSize: sampleJobs.length,
      truncated: kpis.totalJobs > sampleJobs.length,
    },
    recentJobs: recentJobs.map(j => {
      const tag = classificationByJob.get(j.job_number);
      return {
        jobNumber: j.job_number,
        dateOpened: j.date_opened,
        customerComment: j.customer_comment,
        technicianComment: j.technician_comment,
        jobAction: j.job_action,
        status: j.status,
        stage: j.stage,
        category: tag?.category || 'Other',
        outcome: tag?.outcome || 'Unable to Confirm Fault',
      };
    }),
  };
}

// ─── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    const path = event.path || event.resource || '';
    const params = event.queryStringParameters || {};

    let result;
    if (path.endsWith('/search')) {
      result = await handleModelSearch(params.q || '');
    } else {
      if (!params.model || !params.model.trim()) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Missing model parameter' }),
        };
      }
      result = await handleFaultsDashboard(params.model);
      if (result.error === 'not_found') {
        return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify(result) };
      }
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Error:', error);
    const isThrottle = error.name === 'ThrottlingException' || error.$metadata?.httpStatusCode === 429;
    return {
      statusCode: isThrottle ? 429 : 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: isThrottle ? 'too_many_requests' : 'Request failed',
        details: error.message,
      }),
    };
  }
};
