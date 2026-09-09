import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CredentialProvider } from "./sso-login.js";

export interface TerminalCredentialProviderOptions {
  email?: string;
  password?: string;
  /** A one-time code supplied up-front (used once, then the terminal is prompted). */
  otp?: string;
  input?: Readable;
  /** Where prompts and status lines are written (defaults to stderr so stdout stays machine-readable). */
  output?: Writable;
}

/**
 * CredentialProvider for interactive use: takes whatever was passed via
 * flags/env and prompts on the terminal for the rest. Passwords and codes are
 * read without echo.
 */
export class TerminalCredentialProvider implements CredentialProvider {
  private readonly input: Readable;
  private readonly output: Writable;
  private email?: string;
  private password?: string;
  private otp?: string;

  constructor(opts: TerminalCredentialProviderOptions = {}) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stderr;
    this.email = opts.email;
    this.password = opts.password;
    this.otp = opts.otp;
  }

  async getEmail(): Promise<string> {
    return this.email ?? (this.email = await this.ask("Email: "));
  }

  async getPassword(): Promise<string> {
    return this.password ?? (this.password = await this.ask("Password: ", { hidden: true }));
  }

  async getOtp(prompt: string): Promise<string> {
    if (this.otp !== undefined) {
      const once = this.otp;
      this.otp = undefined;
      return once;
    }
    const firstLine = prompt.split("\n").find((l) => l.trim()) ?? "A one-time code is required.";
    this.output.write(`\n${firstLine}\n`);
    return this.ask("Verification code: ", { hidden: true });
  }

  async onNumberMatch(number: string): Promise<void> {
    this.output.write(`\nOpen your Authenticator app and enter the number ${number} to approve the sign-in.\n`);
  }

  onStatus(message: string): void {
    this.output.write(`… ${message}\n`);
  }

  private ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const isTty = Boolean((this.output as NodeJS.WriteStream).isTTY);
      const rl = readline.createInterface({ input: this.input, output: this.output, terminal: isTty });
      if (opts.hidden && isTty) {
        // Echo the prompt but not the typed characters.
        const anyRl = rl as unknown as { _writeToOutput: (s: string) => void };
        const original = anyRl._writeToOutput.bind(rl);
        anyRl._writeToOutput = (s: string) => {
          if (s.startsWith(question)) original(question);
        };
      }
      if (!isTty) this.output.write(question);
      rl.question(isTty ? question : "", (answer) => {
        rl.close();
        if (opts.hidden && isTty) this.output.write("\n");
        resolve(answer.trim());
      });
      rl.on("error", reject);
    });
  }
}
