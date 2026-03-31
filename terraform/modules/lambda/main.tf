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
          "s3:ListBucket"
        ]
        Resource = [
          var.s3_bucket_arn,
          "${var.s3_bucket_arn}/*"
        ]
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
locals {
  lambda_functions = {
    "analyse-enquiry" = "lambdas/analyse-enquiry"  # Bedrock analysis
    "db-warmup"       = "lambdas/db-warmup"        # Wakes Aurora on user login (Cognito post-auth trigger)
    "db-restore"      = "lambdas/db-restore"       # One-time DB restore from S3 — remove after use
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

resource "aws_lambda_function" "functions" {
  for_each = local.lambda_functions

  function_name = "${var.project_name}-${each.key}"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  timeout       = each.key == "analyse-enquiry" ? 60 : each.key == "db-restore" ? 300 : 30
  memory_size   = each.key == "analyse-enquiry" ? 512 : 256

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


