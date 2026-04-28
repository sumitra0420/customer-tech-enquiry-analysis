import json
import io
import os
import re
import csv
import boto3
import pandas as pd

s3 = boto3.client('s3')
lambda_client = boto3.client('lambda', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))


def norm(text):
    """Lowercase, strip all non-alphanumeric characters."""
    return re.sub(r'[^a-z0-9]', '', str(text).lower())


def load_customers(bucket):
    """Load database/customers.csv → list of {customer_id, customer_name, norm_name}."""
    try:
        response = s3.get_object(Bucket=bucket, Key='database/customers.csv')
        content = response['Body'].read().decode('utf-8')
        reader = csv.DictReader(io.StringIO(content))
        customers = []
        for row in reader:
            cid = row.get('customer_id', '').strip()
            name = row.get('customer_name', '').strip()
            if cid and name:
                customers.append({
                    'customer_id': int(cid),
                    'customer_name': name,
                    'norm': norm(name),
                })
        print(f'Loaded {len(customers)} customers for matching')
        return customers
    except Exception as e:
        print(f'Warning: could not load customers.csv: {e}')
        return []


def match_customer(sender, customers):
    """
    Fuzzy-match a raw sender string to a canonical customer.
    Returns customer_id (int) or None.
    """
    if not sender or not customers:
        return None

    norm_sender = norm(sender)
    if not norm_sender or len(norm_sender) < 3:
        return None

    # 1. Exact match
    exact = [c for c in customers if c['norm'] == norm_sender]
    if len(exact) == 1:
        return exact[0]['customer_id']

    # 2. Sender normalizes to start of exactly one customer name
    #    e.g. "jbhifipenrith" starts "jbhifipenrith" in customer "JB HI-FI PENRITH"
    prefix = [c for c in customers if c['norm'] == norm_sender or c['norm'].startswith(norm_sender) and len(norm_sender) >= len(c['norm']) - 3]
    if len(prefix) == 1:
        return prefix[0]['customer_id']

    # 3. Customer name is a prefix of sender (sender has extra words after)
    #    Pick the longest (most specific) match
    suffix = [c for c in customers if norm_sender.startswith(c['norm']) and len(c['norm']) >= 5]
    if suffix:
        best = max(suffix, key=lambda c: len(c['norm']))
        return best['customer_id']

    return None


def handler(event, context):
    # Handle S3 trigger or manual invocation
    if 'Records' in event:
        bucket = event['Records'][0]['s3']['bucket']['name']
        key = event['Records'][0]['s3']['object']['key']
    else:
        bucket = event.get('bucket', os.environ.get('S3_BUCKET'))
        key = event.get('key')

    if not key:
        raise ValueError('No S3 key provided')

    print(f'Processing: s3://{bucket}/{key}')

    customers = load_customers(bucket)

    # Row 0 is "DAILY CONNOTE LOG" title — use row 1 as actual headers
    response = s3.get_object(Bucket=bucket, Key=key)
    content = response['Body'].read()
    df = pd.read_csv(io.BytesIO(content), header=1)
    print(f'Raw: {df.shape[0]} rows, columns: {list(df.columns)}')

    # Strip column names
    df.columns = df.columns.str.strip()

    # Drop Unnamed columns (from Excel exports)
    df = df.loc[:, ~df.columns.str.contains(r'^Unnamed', regex=True)]

    # Drop rows where both SENDER and TRACKING are missing
    df = df.dropna(subset=['SENDER', 'TRACKING'], how='all')

    # Parse date
    df['DATE'] = pd.to_datetime(df['DATE'], dayfirst=True, errors='coerce')

    # Strip whitespace from all string columns
    for col in df.select_dtypes(include='object').columns:
        df[col] = df[col].str.strip()

    # Rename columns to match database schema
    rename_map = {
        'DATE': 'date_received',
        'COURIER': 'courier',
        'TRACKING': 'tracking',
        'RA/REPAIR/REFERENCE': 'reference',
        'SENDER': 'sender',
        'RECEIVED BY': 'received_by',
    }
    df = df.rename(columns=rename_map)

    # Match sender to customer_id
    df['customer_id'] = df['sender'].apply(lambda s: match_customer(s, customers))
    matched = df['customer_id'].notna().sum()
    print(f'Matched {matched}/{len(df)} senders to a customer_id')

    # Keep only expected columns
    expected_cols = ['date_received', 'courier', 'tracking', 'reference', 'sender', 'received_by', 'customer_id']
    df = df[[col for col in expected_cols if col in df.columns]]

    print(f'Clean: {len(df)} rows, columns: {list(df.columns)}')

    # Write cleaned CSV to S3
    output_key = 'database/daily_connote.csv'
    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=False)
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=csv_buffer.getvalue().encode('utf-8'),
        ContentType='text/csv',
    )
    print(f'Written: s3://{bucket}/{output_key}')

    # Trigger db-restore Lambda asynchronously
    db_restore_function = os.environ.get('DB_RESTORE_FUNCTION_NAME')
    if db_restore_function:
        lambda_client.invoke(
            FunctionName=db_restore_function,
            InvocationType='Event',
            Payload=json.dumps({'bucket': bucket}),
        )
        print(f'Triggered db-restore: {db_restore_function}')

    return {
        'statusCode': 200,
        'body': json.dumps({'rows': len(df), 'output': f's3://{bucket}/{output_key}'}),
    }
