import json
import io
import os
import csv
import boto3

s3 = boto3.client('s3')
lambda_client = boto3.client('lambda', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))


def handler(event, context):
    if 'Records' in event:
        bucket = event['Records'][0]['s3']['bucket']['name']
        key = event['Records'][0]['s3']['object']['key']
    else:
        bucket = event.get('bucket', os.environ.get('S3_BUCKET'))
        key = event.get('key')

    if not key:
        raise ValueError('No S3 key provided')

    print(f'Processing: s3://{bucket}/{key}')

    response = s3.get_object(Bucket=bucket, Key=key)
    content = response['Body'].read().decode('utf-8-sig')

    reader = csv.DictReader(io.StringIO(content))
    raw_rows = list(reader)
    print(f'Raw rows: {len(raw_rows)}')

    clean_rows = []
    skipped = 0
    for row in raw_rows:
        cid = row.get('ID', '').strip()
        name = row.get('Name', '').strip().lstrip('#').strip()

        # Drop non-numeric IDs (e.g. XTJ01, ZZZ_TEST_AR) and empty names
        if not cid.isdigit() or not name:
            skipped += 1
            continue

        clean_rows.append({'customer_id': int(cid), 'customer_name': name})

    print(f'Clean: {len(clean_rows)} rows, skipped: {skipped}')

    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=['customer_id', 'customer_name'])
    writer.writeheader()
    writer.writerows(clean_rows)

    output_key = 'database/customers.csv'
    s3.put_object(
        Bucket=bucket,
        Key=output_key,
        Body=out.getvalue().encode('utf-8'),
        ContentType='text/csv',
    )
    print(f'Written: s3://{bucket}/{output_key}')

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
        'body': json.dumps({'rows': len(clean_rows), 'skipped': skipped, 'output': f's3://{bucket}/{output_key}'}),
    }
