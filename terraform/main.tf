# module "vpc" {
#   source       = "./modules/vpc"
#   project_name = var.project_name
# }

module "cognito" {
  source       = "./modules/cognito"
  project_name = var.project_name
}

module "s3" {
  source       = "./modules/s3"
  project_name = var.project_name
  environment  = var.environment
}

# module "rds" {
#   source                = "./modules/rds"
#   project_name          = var.project_name
#   db_name               = var.db_name
#   db_username           = var.db_username
#   db_password           = var.db_password
#   private_subnet_ids    = module.vpc.private_subnet_ids
#   rds_security_group_id = module.vpc.rds_security_group_id
# }

module "lambda" {
  source                   = "./modules/lambda"
  project_name             = var.project_name
  db_host                  = "placeholder"
  db_port                  = 5432
  db_name                  = var.db_name
  db_username              = var.db_username
  db_password              = var.db_password
  s3_bucket_name           = module.s3.bucket_name
  s3_bucket_arn            = module.s3.bucket_arn
  bedrock_model_id         = var.bedrock_model_id
  # private_subnet_ids       = module.vpc.private_subnet_ids
  # lambda_security_group_id = module.vpc.lambda_security_group_id
}

module "frontend" {
  source       = "./modules/frontend"
  project_name = var.project_name
  environment  = var.environment
}

module "api_gateway" {
  source                = "./modules/api-gateway"
  project_name          = var.project_name
  environment           = var.environment
  cognito_user_pool_arn = module.cognito.user_pool_arn
  lambda_invoke_arns    = module.lambda.function_invoke_arns
  lambda_function_arns  = module.lambda.function_arns
}

resource "local_file" "frontend_env" {
  filename = "${path.module}/../src/environments/environments.ts"
  content  = <<EOF
export const environments = {
  production: false,
  apiUrl: '${module.api_gateway.api_url}',
  cognito: {
    userPoolId: '${module.cognito.user_pool_id}',
    userPoolClientId: '${module.cognito.client_id}',
  },
};
EOF
}
