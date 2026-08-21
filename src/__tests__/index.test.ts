import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { SESEmailClient } from "../index";

class MockBody {
  constructor(private readonly value: string) {}

  async transformToByteArray(): Promise<Uint8Array> {
    return Buffer.from(this.value);
  }
}

class MockS3Client {
  public readonly send = vi.fn(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      const input = command.input;
      if (!input.ContinuationToken) {
        return {
          Contents: [
            {
              Key: "test@example.com/old.eml",
              LastModified: new Date("2026-01-01T00:00:00Z"),
              Size: 100,
            },
          ],
          NextContinuationToken: "next",
        };
      }

      return {
        Contents: [
          {
            Key: "test@example.com/new.eml",
            LastModified: new Date("2026-01-02T00:00:00Z"),
            Size: 200,
          },
        ],
      };
    }

    if (command instanceof GetObjectCommand) {
      const key = command.input.Key;
      return {
        Body: new MockBody([
          "From: no-reply@example.com",
          "To: test@example.com",
          `Subject: ${key === "test@example.com/new.eml" ? "Sign in" : "Welcome"}`,
          "",
          key === "test@example.com/new.eml"
            ? "Use https://app.example.com/login?token=abc123 or code 123456."
            : "This is old email.",
        ].join("\r\n")),
      };
    }

    throw new Error("Unexpected command");
  });
}

class NonMatchingS3Client {
  public readonly send = vi.fn(async (command: unknown) => {
    if (command instanceof ListObjectsV2Command) {
      return {
        Contents: [
          {
            Key: "test@example.com/no-match.eml",
            LastModified: new Date("2026-01-02T00:00:00Z"),
            Size: 200,
          },
        ],
      };
    }

    if (command instanceof GetObjectCommand) {
      return {
        Body: new MockBody([
          "From: no-reply@example.com",
          "To: test@example.com",
          "Subject: Welcome",
          "",
          "This body does not match.",
        ].join("\r\n")),
      };
    }

    throw new Error("Unexpected command");
  });
}

function createClient(mockS3Client = new MockS3Client()): SESEmailClient {
  return new SESEmailClient({
    bucketName: "bucket",
    region: "us-east-2",
    s3Client: mockS3Client as never,
  });
}

describe("SESEmailClient", () => {
  it("lists emails across all S3 pages ordered by LastModified", async () => {
    const client = createClient();

    await expect(client.listEmails("test@example.com")).resolves.toEqual([
      "test@example.com/old.eml",
      "test@example.com/new.eml",
    ]);
  });

  it("waits for a matching email after the supplied timestamp", async () => {
    const client = createClient();

    const email = await client.waitForEmail({
      recipientEmail: "test@example.com",
      after: new Date("2026-01-01T12:00:00Z"),
      timeoutMs: 1000,
      pollIntervalMs: 1,
      subjectMatches: /sign in/i,
    });

    expect(email?.subject).toBe("Sign in");
    expect(email?.from).toBe("no-reply@example.com");
  });

  it("extracts links and one-time codes from parsed email bodies", async () => {
    const client = createClient();
    const email = await client.getEmail("test@example.com", "new.eml");
    const globalPattern = /\b\d{6}\b/g;
    globalPattern.lastIndex = 20;

    expect(client.getEmailLink(email, /token=/)).toBe("https://app.example.com/login?token=abc123");
    expect(client.getEmailCodes({ ...email, body: "code 111111", text: undefined, html: "<p>code 222222 222222</p>" }, globalPattern)).toEqual([
      "111111",
      "222222",
    ]);
  });

  it("does not repeatedly fetch unchanged nonmatching candidates while waiting", async () => {
    const mockS3Client = new NonMatchingS3Client();
    const client = createClient(mockS3Client);

    const email = await client.waitForEmail({
      recipientEmail: "test@example.com",
      after: new Date("2026-01-01T00:00:00Z"),
      timeoutMs: 25,
      pollIntervalMs: 1,
      subjectMatches: /sign in/i,
    });

    const getObjectCalls = mockS3Client.send.mock.calls.filter(([command]) => command instanceof GetObjectCommand);
    expect(email).toBeNull();
    expect(getObjectCalls).toHaveLength(1);
  });
});
