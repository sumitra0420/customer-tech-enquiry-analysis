output "vpc_id" {
  value = module.vpc.vpc_id
}
output "cognito_user_pool_id" {
  value = module.cognito.user_pool_id
}

output "cognito_client_id" {
  value = module.cognito.client_id
}

output "s3_bucket_name" {
  value = module.s3.bucket_name
}

# output "rds_endpoint" {
#   value     = module.rds.endpoint
#   sensitive = true
# }

output "api_gateway_url" {
  value = module.api_gateway.api_url
}
