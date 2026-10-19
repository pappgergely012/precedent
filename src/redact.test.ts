import { describe, expect, it } from "vitest";
import { addCounts, createRedactor, describeRedaction, redactText } from "./redact.js";

const r = (s: string) => redactText(s);

describe("redactText", () => {
  it("masks well-known token formats", () => {
    const text = "ghp_abcdefghijklmnopqrstuvwxyz0123456789 and sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ and AKIAABCDEFGHIJKLMNOP and xoxb-1234567890-abcdef";
    const out = r(text);
    expect(out.text).toBe("[REDACTED:token] and [REDACTED:token] and [REDACTED:token] and [REDACTED:token]");
    expect(out.counts).toEqual({ token: 4 });
  });

  it("masks a JWT, bearer tokens and private key blocks", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(r(`token is ${jwt}`).text).toBe("token is [REDACTED:token]");
    expect(r("Authorization: Bearer abcdefghijklmnopqrstuvwx1234").text).toBe("Authorization: Bearer [REDACTED:token]");
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(r(`see\n${key}\nthanks`).text).toBe("see\n[REDACTED:private-key]\nthanks");
    expect(r("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq").text).toBe("[REDACTED:private-key]");
  });

  it("masks credentials in URLs but keeps the host and plain URLs", () => {
    expect(r("clone https://user:hunter2@example.com/repo.git").text).toBe("clone https://[REDACTED:credentials]@example.com/repo.git");
    expect(r("see https://example.com/docs and https://github.com/o/r/pull/1#discussion_r5").text).toBe("see https://example.com/docs and https://github.com/o/r/pull/1#discussion_r5");
  });

  it("masks emails but not mentions, scoped packages or version strings", () => {
    expect(r("ask anna.k+test@example.co.uk please").text).toBe("ask [REDACTED:email] please");
    expect(r("@anna asked for this; import from @types/node; v1.2.3@latest").text).toBe("@anna asked for this; import from @types/node; v1.2.3@latest");
  });

  it("masks long values assigned to secret-looking names and leaves prose and code alone", () => {
    expect(r('api_key = "abcdef0123456789abcdef"').text).toBe('api_key = "[REDACTED:secret]"');
    expect(r("PASSWORD: s3cr3t-value-0123456789").text).toBe("PASSWORD: [REDACTED:secret]");
    expect(r("Do not log the password or the token anywhere.").text).toBe("Do not log the password or the token anywhere.");
    expect(r("const token: string = getToken();").text).toBe("const token: string = getToken();");
    expect(r("password = getPassword()").text).toBe("password = getPassword()");
  });

  it("is idempotent and leaves text without secrets unchanged", () => {
    const plain = "Use assertConsoleErrorDev in tests (see #123).";
    expect(r(plain)).toEqual({ text: plain, counts: {} });
    const once = r("mail me at a@b.io token=abcdefghijklmnopqrstuv").text;
    expect(r(once).text).toBe(once);
  });
});

describe("redaction reporting", () => {
  it("adds counts and describes them without the masked values", () => {
    const total = addCounts(addCounts({}, { email: 2 }), { email: 1, token: 1 });
    expect(total).toEqual({ email: 3, token: 1 });
    const line = describeRedaction(total);
    expect(line).toContain("3 emails, 1 token");
    expect(line).toContain("not a guarantee");
    expect(describeRedaction({})).toContain("found nothing to mask");
  });
});

describe("createRedactor at the prompt boundary", () => {
  it("keeps a secret out of the prompt the model sees when enabled, and leaves text alone when disabled", async () => {
    const { extractRules } = await import("./extract.js");
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const comment = (id: number, body: string) => ({
      id,
      prNumber: 100 + id,
      reviewer: "anna",
      body,
      path: "src/a.ts",
      diffHunk: "@@",
      url: `https://github.com/o/r/pull/${100 + id}#discussion_r${id}`,
      createdAt: "2026-10-01T00:00:00Z",
    });
    const raw = [comment(1, `Please never commit a token like ${secret} or mail bob@example.com about it.`)];
    const prompts: string[] = [];
    const llm = { parse: async (prompt: string, schema: { parse: (x: unknown) => unknown }) => { prompts.push(prompt); return schema.parse({ items: [] }); } };

    const on = createRedactor(true);
    await extractRules(raw.map((c) => ({ ...c, body: on.text(c.body) })), llm as never, {});
    expect(prompts[0]).not.toContain(secret);
    expect(prompts[0]).not.toContain("bob@example.com");
    expect(prompts[0]).toContain("[REDACTED:token]");
    expect(on.line()).toContain("1 token, 1 email");
    expect(on.line()).not.toContain(secret);

    prompts.length = 0;
    const off = createRedactor(false);
    await extractRules(raw.map((c) => ({ ...c, body: off.text(c.body) })), llm as never, {});
    expect(prompts[0]).toContain(secret);
    expect(off.line()).toBeUndefined();
  });

  it("masks Stripe, Google, npm and AWS secret key formats found by QA", () => {
    // Built from parts so this file never contains a literal that secret scanners flag.
    const cases = [
      "STRIPE=" + ["sk", "live", "51H8abcdefghijklmnopqrstuvwxyz"].join("_"),
      ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"),
      ["rk", "live", "51H8abcdefghijklmnopqrstuvwxyz"].join("_"),
      ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join(""),
      "//registry.npmjs.org/:_authToken=" + ["npm", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"),
      ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"),
      "aws_secret_access_key = " + ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/"),
    ];
    for (const text of cases) {
      const out = r(text).text;
      expect(out, text).toContain("[REDACTED:");
      expect(out, text).not.toMatch(/sk_live_51H8abc|sk_test_4eC|AIzaSyA1234|npm_abcdef|wJalrXUtn/);
    }
  });

  it("does not mangle code that merely assigns a secret-named variable", () => {
    for (const text of [
      "api_key = get_api_key_from_environment_variable()",
      "token = request_session_token_value_for_user()",
      "secret = settings.secrets[name_of_the_secret_entry]",
      "see commit 9fceb02d0ae598e95dc970b74767f19372d61af8 and 123e4567-e89b-12d3-a456-426614174000",
      "const apiKey = loadApiKeyFromVaultSomehow(env);",
      "token = request_session_token_value_for_user",
    ]) {
      expect(r(text).text, text).toBe(text);
    }
    expect(r('password = "correcthorsebatterystaple"').text).toBe('password = "[REDACTED:secret]"');
  });
});
