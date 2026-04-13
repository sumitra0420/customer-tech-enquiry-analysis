output "function_arns" {
  value = { for k, v in aws_lambda_function.functions : k => v.arn }
}

output "function_invoke_arns" {
  value = { for k, v in aws_lambda_function.functions : k => v.invoke_arn }
}

output "function_names" {
  value = { for k, v in aws_lambda_function.functions : k => v.function_name }
}

output "repair_data_cleaning_function_name" {
  value = aws_lambda_function.repair_data_cleaning.function_name
}

output "connote_cleaning_function_name" {
  value = aws_lambda_function.connote_cleaning.function_name
}   
