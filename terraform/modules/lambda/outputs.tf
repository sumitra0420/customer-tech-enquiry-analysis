output "function_arns" {
  value = { for k, v in aws_lambda_function.functions : k => v.arn }
}

output "function_invoke_arns" {
  value = { for k, v in aws_lambda_function.functions : k => v.invoke_arn }
}

output "function_names" {
  value = { for k, v in aws_lambda_function.functions : k => v.function_name }
}   
