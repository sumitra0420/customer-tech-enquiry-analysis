# Customer Tech Enquiry Analysis — Claude Instructions

## Active AWS Account
- **Personal account only** (599214518259), AWS profile: `default`
- Lambda name prefix: `tech-enquiry-`
- Region: `ap-southeast-2`
- The company account (333299066447, profile: `company`) is NOT used for active development

## Terraform
```bash
cd terraform && terraform apply
```
No `-var-file` needed — SharePoint credentials are already in `terraform.tfvars`.

## Lambda Deploy Commands

**Node.js:**
```bash
cd lambdas/<name> && zip -r function.zip index.js node_modules/ && aws lambda update-function-code --function-name tech-enquiry-<name> --zip-file fileb://function.zip --region ap-southeast-2
```

**Python:**
```bash
cd lambdas/<name> && zip function.zip index.py && aws lambda update-function-code --function-name tech-enquiry-<name> --zip-file fileb://function.zip --region ap-southeast-2
```

## Lambda Functions

### Node.js (VPC + DB access via `pg`)
| Name | Purpose |
|------|---------|
| `analyse-enquiry` | Bedrock AI analysis |
| `db-restore` | Full DB seed from S3 CSVs + runs schema migrations |
| `db-warmup` | Wakes RDS |
| `receipt-extractor` | Receipt photo → Bedrock vision → DB |
| `connote-db-upload` | Inserts new connote rows (ON CONFLICT tracking DO NOTHING) |

### Python (no VPC, data processing only)
| Name | Purpose |
|------|---------|
| `sharepoint-sync` | Downloads DAILY CONNOTE.xlsx from SharePoint → S3 |
| `connote-excel-cleaning` | Excel → cleaned CSV (triggered by `raw/sharepoint/*.xlsx`) |
| `connote-cleaning` | CSV cleaner (triggered by `uploads/connote/*.csv`) |
| `repair-data-cleaning` | NetSuite CSV cleaner (triggered by `uploads/netsuite/*.csv`) |
| `customer-cleaning` | Customer CSV cleaner (triggered by `uploads/customers/*.csv`) |

## Connote Pipeline
```
SharePoint Excel → raw/sharepoint/*.xlsx
  → connote-excel-cleaning → raw/connote_csv/connote_[timestamp].csv
  → connote-db-upload → daily_connote table (only new tracking numbers inserted)
```

## Key Files
- `lambdas/db-restore/index.js` — schema + full seed logic
- `lambdas/connote-db-upload/index.js` — incremental connote insert
- `lambdas/connote-excel-cleaning/index.py` — Excel cleaner
- `terraform/modules/lambda/main.tf` — all Lambda + S3 trigger definitions
- `terraform/terraform.tfvars` — personal account vars (gitignored)
