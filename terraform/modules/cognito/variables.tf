variable "project_name" {
  type = string
}

variable "db_warmup_lambda_arn" {
  type        = string
  description = "ARN of the db-warmup Lambda — invoked by Cognito post-authentication trigger"
}

variable "aws_region" {
  type        = string
  description = "AWS region — used to scope the Cognito invoke permission"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID — used to scope the Cognito invoke permission"
}
