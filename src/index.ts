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
    this.region = config.region || "us-east-1";
    this.roleArn = config.roleArn;
    this.roleSessionName = config.roleSessionName || "ses-email-reader";

    if (!config.roleArn) {
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
   * @param unreadOnly - If true, only return emails that haven't been read (not implemented yet)
   * @returns The latest email or null if timeout
   */
  async waitForLatestEmail(
    recipientEmail: string,
    timeout: number = 30000,
    unreadOnly: boolean = false
  ): Promise<Email | null> {
    await this.ensureInitialized();
    const startTime = Date.now();
    const recipientFolder = recipientEmail.toLowerCase();

    while (Date.now() - startTime < timeout) {
      const emails = await this.listEmails(recipientFolder);
      if (emails.length > 0) {
        // Get the most recent email (sorted by last modified)
        const latestEmail = emails[emails.length - 1];
        return await this.getEmail(recipientFolder, latestEmail);
      }

      // Wait 1 second before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return null;
  }

  /**
   * List all emails for a recipient
   * @param recipientEmail - Email address of the recipient
   * @returns Array of email file keys
   */
  async listEmails(recipientEmail: string): Promise<string[]> {
    await this.ensureInitialized();
    if (!this.s3Client) {
      throw new Error("S3 client not initialized");
    }

    const recipientFolder = recipientEmail.toLowerCase();
    const command = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: `${recipientFolder}/`,
    });

    const response = await this.s3Client.send(command);
    if (!response.Contents) {
      return [];
    }

    // Sort by LastModified (oldest first)
    return response.Contents.sort((a, b) => {
      const timeA = a.LastModified?.getTime() || 0;
      const timeB = b.LastModified?.getTime() || 0;
      return timeA - timeB;
    }).map((obj) => obj.Key!);
  }

  /**
   * Get a specific email by key
   * @param recipientEmail - Email address of the recipient
   * @param emailKey - S3 key of the email file
   * @returns Parsed email object
   */
  async getEmail(recipientEmail: string, emailKey: string): Promise<Email> {
    await this.ensureInitialized();
    if (!this.s3Client) {
      throw new Error("S3 client not initialized");
    }

    const recipientFolder = recipientEmail.toLowerCase();
    const fullKey = emailKey.startsWith(recipientFolder) ? emailKey : `${recipientFolder}/${emailKey}`;

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: fullKey,
    });

    const response = await this.s3Client.send(command);
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
}

// Export a convenience function similar to MailSlurp
export function createSESEmailClient(config: SESEmailClientConfig): SESEmailClient {
  return new SESEmailClient(config);
}
