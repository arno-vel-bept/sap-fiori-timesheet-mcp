import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { TerminalCredentialProvider } from "../src/auth/prompts.js";

function fakeTty(answers: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => (written += c.toString()));
  // Feed answers lazily: each time something is written to output (a prompt), push the next line.
  output.on("data", () => {
    const next = answers.shift();
    if (next !== undefined) setImmediate(() => input.write(next + "\n"));
  });
  return { input, output, text: () => written };
}

describe("TerminalCredentialProvider", () => {
  it("returns preset email/password without prompting", async () => {
    const tty = fakeTty([]);
    const p = new TerminalCredentialProvider({ email: "a@b.c", password: "pw", input: tty.input, output: tty.output });
    expect(await p.getEmail()).toBe("a@b.c");
    expect(await p.getPassword()).toBe("pw");
    expect(tty.text()).toBe("");
  });

  it("prompts on the terminal for what is missing", async () => {
    const tty = fakeTty(["arno@example.com", "hunter2", "654321"]);
    const p = new TerminalCredentialProvider({ input: tty.input, output: tty.output });
    expect(await p.getEmail()).toBe("arno@example.com");
    expect(await p.getPassword()).toBe("hunter2");
    expect(await p.getOtp("Enter the code")).toBe("654321");
    expect(tty.text()).toMatch(/email/i);
    expect(tty.text()).toMatch(/password/i);
    expect(tty.text()).toMatch(/code/i);
    // The password must never be echoed back.
    expect(tty.text()).not.toContain("hunter2");
  });

  it("prints number-match and status messages", async () => {
    const tty = fakeTty([]);
    const p = new TerminalCredentialProvider({ input: tty.input, output: tty.output });
    await p.onNumberMatch("77");
    p.onStatus("Entering password");
    expect(tty.text()).toContain("77");
    expect(tty.text()).toContain("Entering password");
  });
});
