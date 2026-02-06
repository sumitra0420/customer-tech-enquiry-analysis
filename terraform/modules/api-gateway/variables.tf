variable "project_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "cognito_user_pool_arn" {
  type = string
}

variable "lambda_invoke_arns" {
  type = map(string)
}

variable "lambda_function_arns" {
  type = map(string)
}  
