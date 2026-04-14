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

# /analyse resource
resource "aws_api_gateway_resource" "analyse" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "analyse"
}

# --- POST /analyse ---
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

# --- CORS: OPTIONS /analyse ---
resource "aws_api_gateway_method" "options_analyse" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.analyse.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options_analyse" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.analyse.id
  http_method = aws_api_gateway_method.options_analyse.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "options_analyse" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.analyse.id
  http_method = aws_api_gateway_method.options_analyse.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options_analyse" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.analyse.id
  http_method = aws_api_gateway_method.options_analyse.http_method
  status_code = aws_api_gateway_method_response.options_analyse.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'POST,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# /warmup resource
resource "aws_api_gateway_resource" "warmup" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "warmup"
}

# --- GET /warmup --- (no auth — just wakes Aurora)
resource "aws_api_gateway_method" "warmup" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.warmup.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "warmup" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.warmup.id
  http_method             = aws_api_gateway_method.warmup.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["db-warmup"]
}

# --- CORS: OPTIONS /warmup ---
resource "aws_api_gateway_method" "options_warmup" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.warmup.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options_warmup" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.warmup.id
  http_method = aws_api_gateway_method.options_warmup.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "options_warmup" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.warmup.id
  http_method = aws_api_gateway_method.options_warmup.http_method
  status_code = "200"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options_warmup" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.warmup.id
  http_method = aws_api_gateway_method.options_warmup.http_method
  status_code = aws_api_gateway_method_response.options_warmup.status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# /receipt resource
resource "aws_api_gateway_resource" "receipt" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "receipt"
}

# --- POST /receipt ---
resource "aws_api_gateway_method" "receipt" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.receipt.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "receipt" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.receipt.id
  http_method             = aws_api_gateway_method.receipt.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_invoke_arns["receipt-extractor"]
}

# --- CORS: OPTIONS /receipt ---
resource "aws_api_gateway_method" "options_receipt" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.receipt.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options_receipt" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.receipt.id
  http_method = aws_api_gateway_method.options_receipt.http_method
  type        = "MOCK"
  request_templates = { "application/json" = "{\"statusCode\": 200}" }
}

resource "aws_api_gateway_method_response" "options_receipt" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.receipt.id
  http_method = aws_api_gateway_method.options_receipt.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "options_receipt" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  resource_id = aws_api_gateway_resource.receipt.id
  http_method = aws_api_gateway_method.options_receipt.http_method
  status_code = aws_api_gateway_method_response.options_receipt.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization'"
    "method.response.header.Access-Control-Allow-Methods" = "'POST,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
}

# Lambda permissions for API Gateway
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke-analyse-enquiry"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_arns["analyse-enquiry"]
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_gateway_warmup" {
  statement_id  = "AllowAPIGatewayInvoke-db-warmup"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_arns["db-warmup"]
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "api_gateway_receipt" {
  statement_id  = "AllowAPIGatewayInvoke-receipt-extractor"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_arns["receipt-extractor"]
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

# Deployment
resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.analyse,
      aws_api_gateway_method.analyse_enquiry,
      aws_api_gateway_integration.analyse_enquiry,
      aws_api_gateway_resource.warmup,
      aws_api_gateway_method.warmup,
      aws_api_gateway_integration.warmup,
      aws_api_gateway_resource.receipt,
      aws_api_gateway_method.receipt,
      aws_api_gateway_integration.receipt,
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
