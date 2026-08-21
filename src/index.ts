import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { simpleParser, ParsedMail } from "mailparser";

export interface Email {
  id: string;
  subject: string;
  from: string;
  to: string[];
  body: string;
  html?: string;
  text?: string;
  date?: Date;
  attachments?: Array<{
    filename?: string;
    contentType: string;
    content: Buffer;
  }>;
}

export interface SESEmailClientConfig {
  bucketName: string;
  region?: string;
  roleArn?: string;
  roleSessionName?: string;
  s3Client?: S3Client;
}

export interface EmailSummary {
  key: string;
  lastModified?: Date;
  size?: number;
}

export interface WaitForEmailOptions {
  recipientEmail: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  after?: Date;
  subjectIncludes?: string;
  subjectMatches?: RegExp;
  bodyIncludes?: string;
  bodyMatches?: RegExp;
}

interface AwsRequestOptions {
  abortSignal?: AbortSignal;
}

export class SESEmailClient {
  private s3Client: S3Client | null = null;
  private bucketName: string;
  private region: string;
  private roleArn?: string;
  private roleSessionName?: string;
  private initializationPromise: Promise<void> | null = null;

  constructor(config: SESEmailClientConfig) {
    this.bucketName = config.bucketName;
    this.region = config.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    this.roleArn = config.roleArn;
    this.roleSessionName = config.roleSessionName || "ses-email-reader";

    if (config.s3Client) {
      this.s3Client = config.s3Client;
    } else if (!config.roleArn) {
      // Use default credentials immediately
      this.s3Client = new S3Client({ region: this.region });
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.s3Client) {
      return;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeWithRole();
    }

    await this.initializationPromise;
  }

  private async initializeWithRole(): Promise<void> {
    if (!this.roleArn) {
      throw new Error("Role ARN is required but not provided");
    }

    const stsClient = new STSClient({ region: this.region });
    const assumeRoleResponse = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: this.roleArn,
        RoleSessionName: this.roleSessionName,
      })
    );

    if (!assumeRoleResponse.Credentials) {
      throw new Error("Failed to assume role");
    }

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: assumeRoleResponse.Credentials.AccessKeyId!,
        secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey!,
        sessionToken: assumeRoleResponse.Credentials.SessionToken!,
      },
    });
  }

  /**
   * Wait for the latest email for a given recipient
   * @param recipientEmail - Email address of the recipient (e.g., "test@example.com")
   * @param timeout - Maximum time to wait in milliseconds
   * @param unreadOnly - If true, only consider emails with an S3 LastModified timestamp after the wait starts
   * @returns The latest email or null if timeout
   */
  async waitForLatestEmail(
    recipientEmail: string,
    timeout: number = 30000,
    unreadOnly: boolean = false
  ): Promise<Email | null> {
    return this.waitForEmail({
      recipientEmail,
      timeoutMs: timeout,
      after: unreadOnly ? new Date() : undefined,
    });
  }

  /**
   * Wait for an email that matches the supplied filters.
   */
  async waitForEmail(options: WaitForEmailOptions): Promise<Email | null> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const startTime = Date.now();
    const checkedNonMatchingKeys = new Set<string>();

    while (Date.now() - startTime < timeoutMs) {
      let summaries: EmailSummary[];
      try {
        summaries = await this.withDeadline(
          timeoutMs - (Date.now() - startTime),
          (abortSignal) => this.listEmailSummaries(options.recipientEmail, { abortSignal })
        );
      } catch (error) {
        if (this.isTimeoutError(error)) {
          return null;
        }
        throw error;
      }
      const candidates = summaries
        .filter((summary) => !options.after || (!!summary.lastModified && summary.lastModified >= options.after))
        .sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0));

      for (const summary of candidates) {
        const fingerprint = `${summary.key}:${summary.lastModified?.toISOString() || ""}:${summary.size || 0}`;
        if (checkedNonMatchingKeys.has(fingerprint)) {
          continue;
        }

        if (Date.now() - startTime >= timeoutMs) {
          return null;
        }

        let email: Email;
        try {
          email = await this.withDeadline(
            timeoutMs - (Date.now() - startTime),
            (abortSignal) => this.getEmail(options.recipientEmail, summary.key, { abortSignal })
          );
        } catch (error) {
          if (this.isTimeoutError(error)) {
            return null;
          }
          throw error;
        }

        if (this.emailMatches(email, options)) {
          if (Date.now() - startTime >= timeoutMs) {
            return null;
          }
          return email;
        }

        checkedNonMatchingKeys.add(fingerprint);
      }

      const remainingMs = timeoutMs - (Date.now() - startTime);
      if (remainingMs <= 0) {
        return null;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }

    return null;
  }

  /**
   * List all emails for a recipient
   * @param recipientEmail - Email address of the recipient
   * @returns Array of email file keys
   */
  async listEmails(recipientEmail: string): Promise<string[]> {
    const summaries = await this.listEmailSummaries(recipientEmail);
    return summaries.map((summary) => summary.key);
  }

  /**
   * List all email object summaries for a recipient.
   */
  async listEmailSummaries(recipientEmail: string, requestOptions: AwsRequestOptions = {}): Promise<EmailSummary[]> {
    await this.ensureInitialized();
    if (!this.s3Client) {
      throw new Error("S3 client not initialized");
    }

    const recipientFolder = recipientEmail.toLowerCase();
    const summaries: EmailSummary[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${recipientFolder}/`,
        ContinuationToken: continuationToken,
      });

      const response = await this.s3Client.send(command, requestOptions);
      for (const object of response.Contents || []) {
        if (object.Key) {
          summaries.push({
            key: object.Key,
            lastModified: object.LastModified,
            size: object.Size,
          });
        }
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return summaries.sort((a, b) => {
      const timeA = a.lastModified?.getTime() || 0;
      const timeB = b.lastModified?.getTime() || 0;
      return timeA - timeB;
    });
  }

  /**
   * Get a specific email by key
   * @param recipientEmail - Email address of the recipient
   * @param emailKey - S3 key of the email file
   * @returns Parsed email object
   */
  async getEmail(recipientEmail: string, emailKey: string, requestOptions: AwsRequestOptions = {}): Promise<Email> {
    await this.ensureInitialized();
    if (!this.s3Client) {
      throw new Error("S3 client not initialized");
    }

    const recipientFolder = recipientEmail.toLowerCase();
    const fullKey = emailKey.startsWith(`${recipientFolder}/`) ? emailKey : `${recipientFolder}/${emailKey}`;

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: fullKey,
    });

    const response = await this.s3Client.send(command, requestOptions);
    if (!response.Body) {
      throw new Error(`Email not found: ${fullKey}`);
    }

    const emailBuffer = await response.Body.transformToByteArray();
    const parsed = await simpleParser(Buffer.from(emailBuffer));

    return this.convertParsedMailToEmail(parsed, fullKey);
  }

  /**
   * Get the latest email for a recipient
   * @param recipientEmail - Email address of the recipient
   * @returns The latest email or null if none found
   */
  async getLatestEmail(recipientEmail: string): Promise<Email | null> {
    const emails = await this.listEmails(recipientEmail);
    if (emails.length === 0) {
      return null;
    }

    const latestEmailKey = emails[emails.length - 1];
    return await this.getEmail(recipientEmail, latestEmailKey);
  }

  /**
   * Extract links from an email
   * @param email - Email object
   * @returns Array of URLs found in the email
   */
  getEmailLinks(email: Email): string[] {
    const links: string[] = [];
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

    // Extract from HTML
    if (email.html) {
      const htmlLinks = email.html.match(urlRegex);
      if (htmlLinks) {
        links.push(...htmlLinks);
      }
    }

    // Extract from text
    if (email.text) {
      const textLinks = email.text.match(urlRegex);
      if (textLinks) {
        links.push(...textLinks);
      }
    }

    // Remove duplicates
    return [...new Set(links)];
  }

  /**
   * Return the first link matching a predicate or regex.
   */
  getEmailLink(email: Email, matcher?: RegExp | ((link: string) => boolean)): string | undefined {
    const links = this.getEmailLinks(email);
    if (!matcher) {
      return links[0];
    }
    if (matcher instanceof RegExp) {
      return links.find((link) => {
        matcher.lastIndex = 0;
        return matcher.test(link);
      });
    }
    return links.find(matcher);
  }

  /**
   * Extract one-time codes from the email body. Defaults to 6 digit codes.
   */
  getEmailCodes(email: Email, pattern: RegExp = /\b\d{6}\b/g): string[] {
    const body = this.getSearchableBody(email);
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const globalPattern = new RegExp(pattern.source, flags);
    return [...new Set([...body.matchAll(globalPattern)].map((match) => match[0]))];
  }

  /**
   * Convert mailparser ParsedMail to our Email interface
   */
  private convertParsedMailToEmail(parsed: ParsedMail, key: string): Email {
    const email: Email = {
      id: key,
      subject: parsed.subject || "",
      from: parsed.from?.text || "",
      to: parsed.to
        ? (Array.isArray(parsed.to)
            ? parsed.to.flatMap((a) => (a.value || []).map((v) => v.address || "").filter(Boolean))
            : (parsed.to.value || []).map((v) => v.address || "").filter(Boolean))
        : [],
      body: parsed.text || parsed.html || "",
      html: parsed.html || undefined,
      text: parsed.text || undefined,
      date: parsed.date || undefined,
    };

    if (parsed.attachments && parsed.attachments.length > 0) {
      email.attachments = parsed.attachments.map((att) => ({
        filename: att.filename,
        contentType: att.contentType || "application/octet-stream",
        content: att.content as Buffer,
      }));
    }

    return email;
  }

  private emailMatches(email: Email, options: WaitForEmailOptions): boolean {
    if (options.subjectIncludes && !email.subject.includes(options.subjectIncludes)) {
      return false;
    }

    if (options.subjectMatches) {
      options.subjectMatches.lastIndex = 0;
      if (!options.subjectMatches.test(email.subject)) {
        return false;
      }
    }

    const body = this.getSearchableBody(email);
    if (options.bodyIncludes && !body.includes(options.bodyIncludes)) {
      return false;
    }

    if (options.bodyMatches) {
      options.bodyMatches.lastIndex = 0;
      if (!options.bodyMatches.test(body)) {
        return false;
      }
    }

    return true;
  }

  private getSearchableBody(email: Email): string {
    return [email.body, email.text, email.html].filter(Boolean).join("\n");
  }

  private async withDeadline<T>(remainingMs: number, operation: (abortSignal: AbortSignal) => Promise<T>): Promise<T> {
    if (remainingMs <= 0) {
      throw new Error("Timed out waiting for email");
    }

    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error("Timed out waiting for email"));
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && (error.message === "Timed out waiting for email" || error.name === "AbortError");
  }
}

// Export a convenience function similar to MailSlurp
export function createSESEmailClient(config: SESEmailClientConfig): SESEmailClient {
  return new SESEmailClient(config);
}
