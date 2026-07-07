import json
import io
import os
import boto3
import pandas as pd

s3 = boto3.client('s3')
lambda_client = boto3.client('lambda', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))


def standardise_model(series):
    return (
        series
        .astype(str)
        .str.upper()
        .str.replace(r'\s+', '', regex=True)
        .str.replace('\n', '', regex=False)
        .str.strip()
    )


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

    # Read raw CSV from S3
    response = s3.get_object(Bucket=bucket, Key=key)
    content = response['Body'].read()
    df = pd.read_csv(io.BytesIO(content))
    print(f'Raw: {df.shape[0]} rows, columns: {list(df.columns)}')

    # Strip column names (handles leading/trailing spaces from NetSuite export)
    df.columns = df.columns.str.strip()

    # Drop Unnamed columns (from Excel exports)
    df = df.loc[:, ~df.columns.str.contains(r'^Unnamed', regex=True)]

    # Drop rows with null Job Action or Customer Comment
    before = len(df)
    df = df.dropna(subset=['Job Action'])
    df = df.dropna(subset=['Customer Comment'])
    print(f'Dropped {before - len(df)} rows (null Job Action or Customer Comment)')

    # Drop unwanted columns
    df = df.drop(columns=['Priority', 'Assigned To'], errors='ignore')

    # Parse dates
    df['Date Opened'] = pd.to_datetime(df['Date Opened'], dayfirst=True, errors='coerce')
    df['Date Closed'] = pd.to_datetime(df['Date Closed'], dayfirst=True, errors='coerce')

    # Standardise model name
    df['Model Name'] = standardise_model(df['Model Name'])

    # Combine technician inspection + repair comments
    df['Technician Comment'] = (
        df['Technician Inspection Comments'].fillna('') + ' ' +
        df['Technician Repair Comments'].fillna('')
    ).str.strip()
    df = df.drop(columns=['Technician Inspection Comments', 'Technician Repair Comments'], errors='ignore')

    # Rename columns to match database schema
    rename_map = {
        'Job Number': 'job_number',
        'Model Name': 'product_model',
        'Customer Comment': 'customer_comment',
        'Customer Name': 'customer_name',
        'Date Opened': 'date_opened',
        'Job Action': 'job_action',
        'Technician Comment': 'technician_comment',
        # In case NetSuite exports these as title case
        'Serial Number': 'serial_number',
        'Replacement Serial Number': 'replacement_serial_number',
        'Date Closed': 'date_closed',
        'Status': 'status',
        'Stage': 'stage',
        'Reference': 'reference',
    }
    df = df.rename(columns=rename_map)

    # Keep only expected columns (in schema order)
    expected_cols = [
        'job_number', 'product_model', 'customer_comment', 'customer_name',
        'date_opened', 'date_closed', 'status', 'stage', 'job_action', 'technician_comment',
        'serial_number', 'replacement_serial_number', 'reference',
    ]
    df = df[[col for col in expected_cols if col in df.columns]]

    print(f'Clean: {len(df)} rows, columns: {list(df.columns)}')

    # Log sample row to verify date_closed, status, stage are populated
    sample = df[['job_number', 'date_closed', 'status', 'stage']].dropna(subset=['date_closed', 'status', 'stage'], how='all').head(3)
    if not sample.empty:
        print(f'Sample rows with date_closed/status/stage:\n{sample.to_string(index=False)}')
    else:
        print('WARNING: No rows found with date_closed, status, or stage values — these columns may be missing from the source CSV')

    # Write cleaned CSV to S3
    output_key = 'database/repair_data.csv'
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
            Payload=json.dumps({'bucket': bucket, 'tables': ['repair_jobs']}),
        )
        print(f'Triggered db-restore: {db_restore_function} (repair_jobs only)')

    return {
        'statusCode': 200,
        'body': json.dumps({'rows': len(df), 'output': f's3://{bucket}/{output_key}'}),
    }
