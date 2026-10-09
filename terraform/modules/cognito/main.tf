resource "aws_cognito_user_pool" "main" {
  name = "${var.project_name}-user-pool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  admin_create_user_config {
    allow_admin_create_user_only = var.invite_only

    invite_message_template {
      email_subject = "You're invited to Uniden AI Enquiry Analysis"
      email_message = <<-EOT
        <p>Hi,</p>
        <p>You've been invited to Uniden AI Enquiry Analysis.</p>
        <p>Username: <strong>{username}</strong><br>
        Temporary password: <strong>{####}</strong></p>
        <p>Sign in and you'll be asked to set your own password.</p>
        <p><a href="https://www.uniden.tech">https://www.uniden.tech</a></p>
      EOT
      sms_message   = "Your Uniden AI Enquiry Analysis username is {username} and temporary password is {####}"
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Uniden AI Enquiry Analysis verification code"
    email_message        = <<-EOT
      <p>Hi,</p>
      <p>Your verification code for Uniden AI Enquiry Analysis is: <strong>{####}</strong></p>
      <p>If you didn't request this, you can ignore this email.</p>
      <p><a href="https://www.uniden.tech">https://www.uniden.tech</a></p>
    EOT
    sms_message           = "Your Uniden AI Enquiry Analysis verification code is {####}"
  }

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

  tags = {
    Name = "${var.project_name}-user-pool"
  }
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
