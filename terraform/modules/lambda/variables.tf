variable "project_name" {
  type = string
}

variable "db_host" {
  type = string
}

variable "db_port" {
  type = number
}

variable "db_name" {
  type = string
}

variable "db_username" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "s3_bucket_name" {
  type = string
}

variable "s3_bucket_arn" {
  type = string
}

variable "bedrock_model_id" {
  type = string
}

# VPC variables - kept for future RDS integration but not used currently
variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "lambda_security_group_id" {
  type    = string
  default = ""
}
