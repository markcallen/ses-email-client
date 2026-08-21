# SES Email Client

A Node.js client library for reading emails from AWS SES S3 bucket, designed to be a drop-in replacement for MailSlurp in E2E tests.

## Overview

This package provides a MailSlurp-like API for reading emails stored in an S3 bucket by the SES receiving Terraform module. Emails are organized by recipient in the S3 bucket (e.g., `recipient@example.com/messageId.eml`), and this client provides convenient methods to wait for, retrieve, and parse emails.

## Setup

Install the correct version of node using nvm

```bash
nvm install
nvm use
corepack enable
```

## Installation

```bash
pnpm install
pnpm run build
```

## Prerequisites

1. **AWS Credentials**: You need AWS credentials configured (via `aws configure`, environment variables, or IAM role)
2. **IAM Role Access**: If using the IAM role created by the Terraform module, ensure your IAM user/group has permission to assume the role
3. **S3 Bucket**: The S3 bucket must be created and configured by the SES receiving Terraform module

For the full infrastructure and Playwright setup flow, see [docs/terraform-playwright-setup.md](docs/terraform-playwright-setup.md).

## Usage

### Basic Usage (with IAM Role)

```typescript
import { SESEmailClient } from '@ses-receiving/email-client';

// Get the role ARN from Terraform outputs
const roleArn = process.env.SES_S3_ACCESS_ROLE_ARN;
const bucketName = process.env.SES_BUCKET_NAME; // e.g., from terraform output

const client = new SESEmailClient({
  bucketName: bucketName!,
  region: process.env.AWS_REGION,
  roleArn: roleArn,
  roleSessionName: 'e2e-test-session'
});

const testStartedAt = new Date();

// Trigger your application to send an email, then wait for the new message.
const email = await client.waitForEmail({
  recipientEmail: 'test@example.com',
  after: testStartedAt,
  timeoutMs: 60000,
  subjectMatches: /sign in|magic/i
});

if (email) {
  console.log('Subject:', email.subject);
  console.log('From:', email.from);
  
  // Extract links from email
  const links = client.getEmailLinks(email);
  console.log('Links:', links);
}
```

### Basic Usage (with Default Credentials)

If your AWS credentials already have S3 access, you can omit the role:

```typescript
import { SESEmailClient } from '@ses-receiving/email-client';

const client = new SESEmailClient({
  bucketName: 'ses-inbound-app-markcallen-com',
  region: process.env.AWS_REGION
});

const email = await client.getLatestEmail('test@example.com');
```

### E2E Test Example (Replacing MailSlurp)

```typescript
import { test, expect } from '@playwright/test';
import { SESEmailClient } from '@ses-receiving/email-client';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3006';
const RECIPIENT_EMAIL = 'test@app.markcallen.com'; // Use your SES subdomain

test.describe('Magic Link Authentication', () => {
  let emailClient: SESEmailClient;

  test.beforeAll(async () => {
    const bucketName = process.env.SES_BUCKET_NAME;
    const roleArn = process.env.SES_S3_ACCESS_ROLE_ARN;
    
    if (!bucketName) {
      throw new Error('SES_BUCKET_NAME environment variable is required');
    }

    emailClient = new SESEmailClient({
      bucketName,
      region: process.env.AWS_REGION,
      roleArn: roleArn,
      roleSessionName: 'e2e-test-session'
    });
  });

  test('should authenticate user via magic email link', async ({ page }) => {
    const testStartedAt = new Date();

    // Navigate to sign-in page
    await page.goto(BASE_URL);
    await page.getByTestId('header-signin-button').click();
    await expect(page).toHaveURL(/.*\/auth\/signin/);

    // Enter email and request magic link
    const emailInput = page.locator('input[type="email"]');
    await emailInput.fill(RECIPIENT_EMAIL);
    await page.getByTestId('auth-email-signin-button').click();

    // Wait for confirmation
    await expect(
      page.locator('text=/check your email|magic link sent|email sent/i')
    ).toBeVisible();

    const email = await emailClient.waitForEmail({
      recipientEmail: RECIPIENT_EMAIL,
      after: testStartedAt,
      timeoutMs: 60000,
      subjectMatches: /sign in|magic/i
    });

    expect(email).toBeTruthy();
    expect(email.subject).toContain('Sign in');

    // Extract the magic link from the email
    const loginLink = emailClient.getEmailLink(email!, link => link.includes('localhost'));

    expect(loginLink).toBeTruthy();

    // Navigate to the magic link
    await page.goto(loginLink!);
    await expect(page).toHaveURL(/.*\/onboarding/);
  });
});
```

## API Reference

### `SESEmailClient`

Main client class for interacting with SES emails in S3.

#### Constructor

```typescript
new SESEmailClient(config: SESEmailClientConfig)
```

**Config Options:**
- `bucketName` (string, required): Name of the S3 bucket containing emails
- `region` (string, optional): AWS region (default: "us-east-1")
- `roleArn` (string, optional): ARN of IAM role to assume for S3 access
- `roleSessionName` (string, optional): Session name for role assumption (default: "ses-email-reader")
- `s3Client` (S3Client, optional): Preconfigured S3 client, primarily useful for tests or custom credential providers

#### Methods

##### `waitForLatestEmail(recipientEmail, timeout, unreadOnly)`

Backwards-compatible helper that waits for the latest email to arrive for a recipient. Prefer `waitForEmail` for new tests.

- `recipientEmail` (string): Email address of the recipient
- `timeout` (number): Maximum time to wait in milliseconds (default: 30000)
- `unreadOnly` (boolean): If true, only considers emails created after the wait starts

Returns: `Promise<Email | null>`

##### `waitForEmail(options)`

Waits for an email matching optional filters. Pass `after` to exclude messages that were already present in the bucket.

- `recipientEmail` (string): Email address of the recipient
- `timeoutMs` (number): Maximum time to wait in milliseconds (default: 30000)
- `pollIntervalMs` (number): Delay between S3 polls in milliseconds (default: 1000)
- `after` (Date): Only consider objects with `LastModified` at or after this time
- `subjectIncludes` / `subjectMatches`: Optional subject filters
- `bodyIncludes` / `bodyMatches`: Optional body filters

Returns: `Promise<Email | null>`

##### `getLatestEmail(recipientEmail)`

Gets the most recent email for a recipient without waiting.

- `recipientEmail` (string): Email address of the recipient

Returns: `Promise<Email | null>`

##### `listEmails(recipientEmail)`

Lists all email keys for a recipient.

- `recipientEmail` (string): Email address of the recipient

Returns: `Promise<string[]>` - Array of S3 object keys

##### `listEmailSummaries(recipientEmail)`

Lists all email object summaries for a recipient, including key, last modified time, and size. This method handles S3 pagination.

Returns: `Promise<EmailSummary[]>`

##### `getEmail(recipientEmail, emailKey)`

Retrieves and parses a specific email.

- `recipientEmail` (string): Email address of the recipient
- `emailKey` (string): S3 key of the email file

Returns: `Promise<Email>`

##### `getEmailLinks(email)`

Extracts all URLs from an email's HTML and text content.

- `email` (Email): Email object

Returns: `string[]` - Array of URLs found in the email

##### `getEmailLink(email, matcher)`

Returns the first URL in the email, or the first URL matching a regex or predicate function.

Returns: `string | undefined`

##### `getEmailCodes(email, pattern)`

Extracts one-time codes from the email body. The default pattern returns 6 digit codes.

Returns: `string[]`

## Email Interface

```typescript
interface Email {
  id: string;              // S3 key of the email
  subject: string;         // Email subject
  from: string;           // Sender email address
  to: string[];           // Recipient email addresses
  body: string;           // Email body (text or HTML)
  html?: string;          // HTML content if available
  text?: string;          // Plain text content if available
  date?: Date;            // Email date
  attachments?: Array<{   // Email attachments
    filename?: string;
    contentType: string;
    content: Buffer;
  }>;
}
```

## Environment Variables

For E2E tests, set these environment variables:

```bash
# Required
SES_BUCKET_NAME=ses-inbound-app-markcallen-com

# Optional (if using IAM role)
SES_S3_ACCESS_ROLE_ARN=arn:aws:iam::123456789012:role/ses-inbound-app-s3-access-role

# Optional
AWS_REGION=us-east-2
```

You can get these values from Terraform outputs:

```bash
# Get bucket name
terraform output -raw s3_bucket_name

# Get role ARN
terraform output -raw s3_access_role_arn
```

## Differences from MailSlurp

1. **No Inbox Creation**: Emails are sent to real email addresses (your SES subdomain), not virtual inboxes
2. **Recipient-Based**: Use the actual recipient email address instead of an inbox ID
3. **S3 Storage**: Emails are stored in S3, not in MailSlurp's service
4. **IAM Role**: Requires AWS IAM role assumption (if configured) instead of API key

## Troubleshooting

### "Access Denied" Errors

- Ensure your IAM user/group has permission to assume the S3 access role
- Verify the role ARN is correct
- Check that the S3 bucket policy allows access

### "Email Not Found" Errors

- Verify the recipient email matches exactly (case-insensitive)
- Check that emails have been received and processed by the Lambda function
- Ensure the email address uses your SES subdomain (e.g., `test@app.markcallen.com`)

### "Role Assumption Failed" Errors

- Verify the role ARN is correct
- Ensure your IAM user has the assume role policy attached
- Check AWS credentials are configured correctly

## Development

```bash
# Install dependencies
pnpm install

# Build TypeScript
pnpm run build

# Run typecheck tests
pnpm test
```

The test suite uses Vitest and mocked AWS clients; it does not call AWS.

## License

ISC
