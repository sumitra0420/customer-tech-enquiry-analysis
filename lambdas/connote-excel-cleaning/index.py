import io
import os
import re
import boto3
import pandas as pd
from datetime import datetime, timezone

s3 = boto3.client('s3')


def handler(event, context):
    bucket = event['Records'][0]['s3']['bucket']['name']
    key = event['Records'][0]['s3']['object']['key']

    print(f'Processing: s3://{bucket}/{key}')

    # Extract timestamp from filename: raw/sharepoint/connote_YYYYMMDD_HHMMSS.xlsx
    match = re.search(r'connote_(\d{8}_\d{6})\.xlsx$', key)
    timestamp = match.group(1) if match else datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')

    # Download Excel from S3
    response = s3.get_object(Bucket=bucket, Key=key)
    content = response['Body'].read()

    # Find the current month's sheet (e.g. "JUNE 2026")
    current_month = datetime.now().strftime('%B %Y').upper()
    all_sheets = pd.read_excel(io.BytesIO(content), sheet_name=None, header=None)

    sheet_names = list(all_sheets.keys())
    print(f'Sheets found: {sheet_names}')

    target_sheet = next((s for s in sheet_names if s.upper() == current_month), None)
    if target_sheet is None:
        # Fall back to the first (leftmost) sheet
        target_sheet = sheet_names[0]
        print(f'Sheet "{current_month}" not found, falling back to "{target_sheet}"')
    else:
        print(f'Using sheet: {target_sheet}')

    # Row 0 = "DAILY CONNOTE LOG" title, row 1 = actual headers
    df = pd.read_excel(io.BytesIO(content), sheet_name=target_sheet, header=1)
    print(f'Raw: {df.shape[0]} rows, columns: {list(df.columns)}')

    # Strip column names
    df.columns = df.columns.str.strip()

    # Drop fully empty rows and Unnamed columns
    df = df.loc[:, ~df.columns.str.contains(r'^Unnamed', regex=True)]
    df = df.dropna(how='all')

    # Drop rows with no tracking number — can't identify record without it
    tracking_col = next((c for c in df.columns if 'TRACKING' in c.upper()), None)
    if tracking_col:
        before = len(df)
        df = df[df[tracking_col].notna() & (df[tracking_col].astype(str).str.strip() != '')]
        print(f'Dropped {before - len(df)} rows with no tracking number')

    # Keep raw date text for reference
    date_col = next((c for c in df.columns if c.upper() == 'DATE'), None)
    df['date_entry'] = df[date_col].astype(str).str.strip() if date_col else None

    # Use download timestamp as the authoritative received date
    df['received_date'] = datetime.now().strftime('%Y-%m-%d')

    # Normalise column names — map known variants
    rename_map = {
        'COURIER': 'courier',
        'TRACKING': 'tracking',
        'RA/REPAIR/REFERENCE': 'reference',
        'SENDER': 'sender',
        'RECEIVED BY': 'received_by',
    }
    df = df.rename(columns={c: rename_map[c.strip().upper()] for c in df.columns if c.strip().upper() in rename_map})

    # Strip whitespace from all string columns
    for col in df.select_dtypes(include='object').columns:
        df[col] = df[col].astype(str).str.strip().replace('nan', None)

    # Keep only expected output columns
    expected_cols = ['received_date', 'date_entry', 'courier', 'tracking', 'reference', 'sender', 'received_by']
    df = df[[col for col in expected_cols if col in df.columns]]

    print(f'Clean: {len(df)} rows, columns: {list(df.columns)}')

    # Write CSV to raw/connote_csv/connote_[timestamp].csv
    output_key = f'raw/connote_csv/connote_{timestamp}.csv'
    csv_buffer = io.StringIO()
    df.to_csv(csv_buffer, index=False)
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=csv_buffer.getvalue().encode('utf-8'),
        ContentType='text/csv',
    )
    print(f'Written: s3://{bucket}/{output_key}')

    return {
        'statusCode': 200,
        'body': f'{{"rows": {len(df)}, "output": "s3://{bucket}/{output_key}"}}',
    }
