resource "aws_api_gateway_rest_api" "main" {
  name        = "${var.project_name}-api"
  description = "Customer Tech Enquiry Analysis API"
}

resource "aws_api_gateway_authorizer" "cognito" {
  name            = "${var.project_name}-cognito-auth"
  rest_api_id     = aws_api_gateway_rest_api.main.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"
}

# /enquiries resource                                                                                         
resource "aws_api_gateway_resource" "enquiries" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "enquiries"
}

# /enquiries/{id} resource                                                                                    
resource "aws_api_gateway_resource" "enquiry" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.enquiries.id
  path_part   = "{id}"
}

# /enquiries/{id}/analyse resource                                                                            
resource "aws_api_gateway_resource" "analyse" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.enquiry.id
  path_part   = "analyse"
}

# --- GET /enquiries ---                                                                                      
resource "aws_api_gateway_method" "get_enquiries" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.enquiries.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_enquiries" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.enquiries.id
  http_method             = aws_api_gateway_method.get_enquiries.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["enquiries"]
}

# --- POST /enquiries ---                                                                                     
resource "aws_api_gateway_method" "create_enquiry" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.enquiries.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "create_enquiry" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.enquiries.id
  http_method             = aws_api_gateway_method.create_enquiry.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["enquiries"]
}

# --- GET /enquiries/{id} ---                                                                                 
resource "aws_api_gateway_method" "get_enquiry" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.enquiry.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "get_enquiry" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.enquiry.id
  http_method             = aws_api_gateway_method.get_enquiry.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["enquiries"]
}

# --- PUT /enquiries/{id} ---                                                                                 
resource "aws_api_gateway_method" "update_enquiry" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.enquiry.id
  http_method   = "PUT"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "update_enquiry" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.enquiry.id
  http_method             = aws_api_gateway_method.update_enquiry.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["enquiries"]
}

# --- DELETE /enquiries/{id} ---                                                                              
resource "aws_api_gateway_method" "delete_enquiry" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.enquiry.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "delete_enquiry" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.enquiry.id
  http_method             = aws_api_gateway_method.delete_enquiry.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["enquiries"]
}

# --- POST /enquiries/{id}/analyse ---                                                                        
resource "aws_api_gateway_method" "analyse_enquiry" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.analyse.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "analyse_enquiry" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.analyse.id
  http_method             = aws_api_gateway_method.analyse_enquiry.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["analyse-enquiry"]
}

# --- CORS: OPTIONS methods ---                                                                               
locals {
  cors_resources = {
    "enquiries" = aws_api_gateway_resource.enquiries.id
    "enquiry"   = aws_api_gateway_resource.enquiry.id
    "analyse"   = aws_api_gateway_resource.analyse.id
  }
}

resource "aws_api_gateway_method" "options" {
  for_each = local.cors_resources

  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = each.value
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  for_each = local.cors_resources

  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value
  http_method = aws_api_gateway_method.options[each.key].http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "options" {
  for_each = local.cors_resources

  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value
  http_method = aws_api_gateway_method.options[each.key].http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options" {
  for_each = local.cors_resources

  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = each.value
  http_method = aws_api_gateway_method.options[each.key].http_method
  status_code = aws_api_gateway_method_response.options[each.key].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,POST,PUT,DELETE,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# Lambda permissions for API Gateway                                                                          
resource "aws_lambda_permission" "api_gateway" {
  for_each = var.lambda_function_arns

  statement_id  = "AllowAPIGatewayInvoke-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = each.value
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# Deployment                                                                                                  
resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.enquiries,
      aws_api_gateway_resource.enquiry,
      aws_api_gateway_resource.analyse,
      aws_api_gateway_method.get_enquiries,
      aws_api_gateway_method.create_enquiry,
      aws_api_gateway_method.get_enquiry,
      aws_api_gateway_method.update_enquiry,
      aws_api_gateway_method.delete_enquiry,
      aws_api_gateway_method.analyse_enquiry,
      aws_api_gateway_integration.get_enquiries,
      aws_api_gateway_integration.create_enquiry,
      aws_api_gateway_integration.get_enquiry,
      aws_api_gateway_integration.update_enquiry,
      aws_api_gateway_integration.delete_enquiry,
      aws_api_gateway_integration.analyse_enquiry,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "main" {
  deployment_id = aws_api_gateway_deployment.main.id
  rest_api_id   = aws_api_gateway_rest_api.main.id
  stage_name    = var.environment
}
