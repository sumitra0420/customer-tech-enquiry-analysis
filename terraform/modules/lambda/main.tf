resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.project_name}-lambda-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject"
        ]
        Resource = [
          var.s3_bucket_arn,
          "${var.s3_bucket_arn}/*"
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = "arn:aws:lambda:*:*:function:${var.project_name}-db-restore"
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "aws-marketplace:ViewSubscriptions",
          "aws-marketplace:Subscribe"
        ]
        Resource = "*"
      },
      {
        # Required for Lambda to attach to a VPC (create/describe/delete ENIs)
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses"
        ]
        Resource = "*"
      }
    ]
  })
}

data "archive_file" "placeholder" {
  type        = "zip"
  output_path = "${path.module}/placeholder.zip"

  source {
    content  = "exports.handler = async () => ({ statusCode: 200, body: 'placeholder' });"
    filename = "index.js"
  }
}

data "archive_file" "placeholder_python" {
  type        = "zip"
  output_path = "${path.module}/placeholder_python.zip"

  source {
    content  = "def handler(event, context): return {'statusCode': 200}"
    filename = "index.py"
  }
}
locals {
  lambda_functions = {
    "analyse-enquiry"   = "lambdas/analyse-enquiry"   # Bedrock analysis
    "db-warmup"         = "lambdas/db-warmup"         # Wakes Aurora
    "db-restore"        = "lambdas/db-restore"        # DB restore from S3
    "receipt-extractor" = "lambdas/receipt-extractor" # Receipt photo → Bedrock vision → Aurora
  }

  common_env_vars = {
    DB_HOST          = var.db_host
    DB_PORT          = tostring(var.db_port)
    DB_NAME          = var.db_name
    DB_USER          = var.db_username
    DB_PASSWORD      = var.db_password
    DB_SSL           = "true"
    S3_BUCKET        = var.s3_bucket_name
    BEDROCK_MODEL_ID = var.bedrock_model_id
  }
}

# connote-cleaning: Python Lambda triggered by S3 upload
# Upload raw connote CSV to s3://bucket/uploads/connote/filename.csv → auto-cleans → db-restore
resource "aws_lambda_function" "connote_cleaning" {
  function_name = "${var.project_name}-connote-cleaning"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "python3.11"
  timeout       = 120
  memory_size   = 256

  filename         = data.archive_file.placeholder_python.output_path
  source_code_hash = data.archive_file.placeholder_python.output_base64sha256

  layers = ["arn:aws:lambda:ap-southeast-2:336392948345:layer:AWSSDKPandas-Python311:18"]

  environment {
    variables = {
      S3_BUCKET                = var.s3_bucket_name
      DB_RESTORE_FUNCTION_NAME = "${var.project_name}-db-restore"
    }
  }

  tags = {
    Name = "${var.project_name}-connote-cleaning"
  }
}

resource "aws_lambda_permission" "s3_invoke_connote_cleaning" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.connote_cleaning.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = var.s3_bucket_arn
}

# repair-data-cleaning: Python Lambda triggered by S3 upload
# Upload raw NetSuite CSV to s3://bucket/uploads/netsuite/filename.csv → auto-cleans → db-restore
resource "aws_lambda_function" "repair_data_cleaning" {
  function_name = "${var.project_name}-repair-data-cleaning"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "python3.11"
  timeout       = 300
  memory_size   = 512

  filename         = data.archive_file.placeholder_python.output_path
  source_code_hash = data.archive_file.placeholder_python.output_base64sha256

  # AWS managed pandas layer for ap-southeast-2
  # Check latest version: https://aws-sdk-pandas.readthedocs.io/en/stable/layers.html
  layers = ["arn:aws:lambda:ap-southeast-2:336392948345:layer:AWSSDKPandas-Python311:18"]

  environment {
    variables = {
      S3_BUCKET                = var.s3_bucket_name
      DB_RESTORE_FUNCTION_NAME = "${var.project_name}-db-restore"
    }
  }

  tags = {
    Name = "${var.project_name}-repair-data-cleaning"
  }
}

# Allow S3 to invoke repair-data-cleaning
resource "aws_lambda_permission" "s3_invoke_repair_cleaning" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.repair_data_cleaning.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = var.s3_bucket_arn
}

# S3 triggers — one notification resource covers both upload paths
resource "aws_s3_bucket_notification" "s3_uploads" {
  bucket = var.s3_bucket_name

  lambda_function {
    lambda_function_arn = aws_lambda_function.repair_data_cleaning.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/netsuite/"
    filter_suffix       = ".csv"
  }

  lambda_function {
    lambda_function_arn = aws_lambda_function.connote_cleaning.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/connote/"
    filter_suffix       = ".csv"
  }

  depends_on = [
    aws_lambda_permission.s3_invoke_repair_cleaning,
    aws_lambda_permission.s3_invoke_connote_cleaning,
  ]
}

resource "aws_lambda_function" "functions" {
  for_each = local.lambda_functions

  function_name = "${var.project_name}-${each.key}"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = each.key == "analyse-enquiry" ? 60 : each.key == "db-restore" ? 300 : each.key == "receipt-extractor" ? 60 : each.key == "db-warmup" ? 60 : 30
  memory_size   = each.key == "analyse-enquiry" || each.key == "receipt-extractor" ? 512 : 256

  filename         = data.archive_file.placeholder.output_path
  source_code_hash = data.archive_file.placeholder.output_base64sha256

  dynamic "vpc_config" {
    for_each = length(var.private_subnet_ids) > 0 ? [1] : []
    content {
      subnet_ids         = var.private_subnet_ids
      security_group_ids = [var.lambda_security_group_id]
    }
  }

  environment {
    variables = local.common_env_vars
  }

  tags = {
    Name = "${var.project_name}-${each.key}"
  }
}


