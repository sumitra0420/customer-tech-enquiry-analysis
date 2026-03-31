resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-user-pool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  schema {
    name                = "name"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  # Post-Authentication trigger — fires every time a user successfully logs in.
  # Used to wake Aurora before the user reaches the Analyse page.
  lambda_config {
    post_authentication = var.db_warmup_lambda_arn
  }

  tags = {
    Name = "${var.project_name}-user-pool"
  }

  depends_on = [aws_lambda_permission.cognito_invoke_warmup]
}

# Allow Cognito to invoke the db-warmup Lambda.
# Without this permission, Cognito will be blocked by IAM and the trigger won't fire.
resource "aws_lambda_permission" "cognito_invoke_warmup" {
  statement_id  = "AllowCognitoInvokeWarmup"
  action        = "lambda:InvokeFunction"
  function_name = var.db_warmup_lambda_arn
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = "arn:aws:cognito-idp:${var.aws_region}:${var.aws_account_id}:userpool/*"
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "${var.project_name}-client"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH"
  ]

  supported_identity_providers = ["COGNITO"]
}
