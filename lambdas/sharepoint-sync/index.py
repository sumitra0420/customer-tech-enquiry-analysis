import json
import os
import boto3
import urllib.request
import urllib.parse

s3 = boto3.client('s3')
secrets = boto3.client('secretsmanager', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))

SECRET_NAME = os.environ.get('SHAREPOINT_SECRET_NAME', 'tech-enquiry/sharepoint-credentials')
S3_BUCKET = os.environ['S3_BUCKET']

DRIVE_ID = 'b!jp8NK0_pBEavZSoam906ObYCGL02fUFPi5K9ZCGrRUfBgBP6o2UkT4k1bk4h0uvZ'
FILE_NAME = 'DAILY CONNOTE.xlsx'
S3_KEY = 'raw/daily_connote.xlsx'


def get_credentials():
    response = secrets.get_secret_value(SecretId=SECRET_NAME)
    creds = json.loads(response['SecretString'])
    return creds['TENANT_ID'], creds['CLIENT_ID'], creds['CLIENT_SECRET']


def get_access_token(tenant_id, client_id, client_secret):
    url = f'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token'
    data = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'client_id': client_id,
        'client_secret': client_secret,
        'scope': 'https://graph.microsoft.com/.default',
    }).encode()

    req = urllib.request.Request(url, data=data, method='POST')
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read())

    print('Access token obtained')
    return result['access_token']


def download_file(token):
    encoded_file = urllib.parse.quote(FILE_NAME)
    url = f'https://graph.microsoft.com/v1.0/drives/{DRIVE_ID}/root:/{encoded_file}:/content'

    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req) as response:
        content = response.read()

    print(f'Downloaded {len(content)} bytes')
    return content


def handler(event, context):
    print(f'Downloading "{FILE_NAME}" from SharePoint drive: {DRIVE_ID}')

    tenant_id, client_id, client_secret = get_credentials()
    token = get_access_token(tenant_id, client_id, client_secret)
    content = download_file(token)

    s3.put_object(
        Bucket=S3_BUCKET,
        Key=S3_KEY,
        Body=content,
        ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )

    print(f'Saved to s3://{S3_BUCKET}/{S3_KEY}')

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Download successful',
            'file': FILE_NAME,
            's3': f's3://{S3_BUCKET}/{S3_KEY}',
            'size_bytes': len(content),
        }),
    }
