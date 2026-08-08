# Terraform and Playwright Setup

This guide shows how to add the SES receiving Terraform module to an existing Terraform project, export the values needed by this client, and use the client in Playwright tests.

## 1. Add the Terraform Module

Configure the AWS provider in your application Terraform project. SES receiving is region-specific, so use one of the regions supported by SES receiving.

```hcl
provider "aws" {
  alias  = "ses_receiving"
  region = "us-east-2"
}

module "ses_receiving" {
  source = "git::ssh://git@github.com/your-org/ses-receiving-terraform.git?ref=v0.1.0"

  providers = {
    aws = aws.ses_receiving
  }

  region         = "us-east-2"
  subdomain_fqdn = "mail.example.com"
  bucket_name    = "example-mail-inbound-prod"
  project_tag    = "example-mail-prod"
  project        = "example"
  environment    = "prod"

  # Safe default for existing projects: create the rule set, but do not
  # automatically make it active unless this project owns SES receiving.
  create_receipt_rule_set   = true
  activate_receipt_rule_set = false

  # Trust the role used by your Playwright runner, CI job, or developer.
  trusted_reader_principal_arns = [
    aws_iam_role.playwright_tests.arn
  ]
}
```

Expose the values Playwright needs from the consuming Terraform project:

```hcl
output "s3_bucket_name" {
  value = module.ses_receiving.s3_bucket_name
}

output "s3_access_role_arn" {
  value = module.ses_receiving.s3_access_role_arn
}

output "subdomain_fqdn" {
  value = module.ses_receiving.subdomain_fqdn
}

output "region" {
  value = module.ses_receiving.region
}
```

If your AWS account already has an SES receipt rule set, add the rule to it instead of creating and activating a new one:

```hcl
module "ses_receiving" {
  source = "git::ssh://git@github.com/your-org/ses-receiving-terraform.git?ref=v0.1.0"

  providers = {
    aws = aws.ses_receiving
  }

  region                  = "us-east-2"
  subdomain_fqdn          = "mail.example.com"
  bucket_name             = "example-mail-inbound-prod"
  project_tag             = "example-mail-prod"
  project                 = "example"
  environment             = "prod"
  create_receipt_rule_set = false
  receipt_rule_set_name   = "existing-rule-set"

  trusted_reader_principal_arns = [
    aws_iam_role.playwright_tests.arn
  ]
}
```

Only set `activate_receipt_rule_set = true` if this Terraform stack should own the active SES receipt rule set for the account and region. SES allows one active receipt rule set per account and region.

## 2. Configure DNS

After `terraform apply`, publish the DNS records from the Terraform output:

```bash
terraform output dns_records_summary
```

You need:

- MX record for receiving email at `subdomain_fqdn`
- TXT record for SES domain verification
- DKIM CNAME records

Wait until SES verifies the identity:

```bash
aws ses get-identity-verification-attributes \
  --identities "$(terraform output -raw subdomain_fqdn)" \
  --region "$(terraform output -raw region 2>/dev/null || echo us-east-2)"
```

If you did not set `activate_receipt_rule_set = true`, activate the rule set manually or from the Terraform stack that owns SES receiving:

```bash
terraform output -raw rule_set_activation_command
```

## 3. Export Client Environment Variables

From the Terraform project, export the values used by Playwright:

```bash
export SES_BUCKET_NAME="$(terraform output -raw s3_bucket_name)"
export SES_S3_ACCESS_ROLE_ARN="$(terraform output -raw s3_access_role_arn)"
export SES_SUBDOMAIN="$(terraform output -raw subdomain_fqdn)"
export AWS_REGION="us-east-2"
```

If your Playwright process already runs as a role or user with direct S3 read access, `SES_S3_ACCESS_ROLE_ARN` is optional.

## 4. Install the Client

Install the package from wherever you publish or reference it. For a local sibling checkout during development:

```bash
pnpm add ../ses-email-client
```

For a private Git repo:

```bash
pnpm add git+ssh://git@github.com/your-org/ses-email-client.git#v0.1.0
```

## 5. Playwright Magic Link Test

Use a unique recipient per test run and only wait for emails created after the test starts. That avoids accidentally reading an older email from the same S3 prefix.

```ts
import { expect, test } from "@playwright/test";
import { SESEmailClient } from "@ses-receiving/email-client";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const subdomain = process.env.SES_SUBDOMAIN;

test("signs in with a magic link", async ({ page }, testInfo) => {
  if (!subdomain || !process.env.SES_BUCKET_NAME) {
    throw new Error("SES_SUBDOMAIN and SES_BUCKET_NAME are required");
  }

  const emailClient = new SESEmailClient({
    bucketName: process.env.SES_BUCKET_NAME,
    region: process.env.AWS_REGION,
    roleArn: process.env.SES_S3_ACCESS_ROLE_ARN,
    roleSessionName: `playwright-${testInfo.workerIndex}`,
  });

  const testStartedAt = new Date();
  const recipientEmail = `e2e-${Date.now()}-${testInfo.workerIndex}@${subdomain}`;

  await page.goto(baseUrl);
  await page.getByLabel(/email/i).fill(recipientEmail);
  await page.getByRole("button", { name: /sign in|send link/i }).click();

  const email = await emailClient.waitForEmail({
    recipientEmail,
    after: testStartedAt,
    timeoutMs: 60000,
    subjectMatches: /sign in|login|magic/i,
  });

  expect(email, "expected magic link email to arrive").not.toBeNull();

  const magicLink = emailClient.getEmailLink(email!, (link) =>
    link.includes(baseUrl) || link.includes("token=")
  );

  expect(magicLink, "expected email to contain a magic link").toBeTruthy();

  await page.goto(magicLink!);
  await expect(page).toHaveURL(/dashboard|onboarding|account/);
});
```

## 6. Playwright One-Time Code Test

For apps that send a numeric code instead of a link:

```ts
const email = await emailClient.waitForEmail({
  recipientEmail,
  after: testStartedAt,
  timeoutMs: 60000,
  bodyMatches: /\b\d{6}\b/,
});

expect(email, "expected verification code email to arrive").not.toBeNull();

const [code] = emailClient.getEmailCodes(email!);
expect(code, "expected a 6 digit verification code").toMatch(/^\d{6}$/);

await page.getByLabel(/code/i).fill(code);
await page.getByRole("button", { name: /verify|continue/i }).click();
```

## 7. Verify That a User Received Email

For assertions that an email was delivered, wait for a message after the action and assert on subject or body content:

```ts
const testStartedAt = new Date();

await page.getByRole("button", { name: /send invitation/i }).click();

const email = await emailClient.waitForEmail({
  recipientEmail: "new-user@mail.example.com",
  after: testStartedAt,
  timeoutMs: 60000,
  subjectIncludes: "You're invited",
  bodyIncludes: "Create your account",
});

expect(email).not.toBeNull();
expect(email?.to).toContain("new-user@mail.example.com");
expect(email?.from).toContain("no-reply");
```

## Troubleshooting

- `AccessDenied`: confirm the Playwright principal is in `trusted_reader_principal_arns`, or that its IAM policy allows `sts:AssumeRole` for `s3_access_role_arn`.
- No email arrives: check the MX record, SES domain verification, and the active receipt rule set.
- Email appears in `incoming/` but not under the recipient prefix: check the Lambda CloudWatch log group from `cloudwatch_log_group_name`.
- Test reads an old email: pass `after: new Date()` before triggering the email, and use unique recipient addresses for parallel tests.
