import { LoginError, ssoLogin, type CredentialProvider, type SsoLoginOptions, type LoginErrorCode } from "./sso-login.js";
import type { SessionData } from "./session-store.js";

export type LoginStep =
  | { state: "otp_required"; prompt: string }
  | { state: "number_match"; number: string }
  | { state: "done"; session: SessionData }
  | { state: "error"; code: LoginErrorCode | "unknown"; message: string };

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Step-wise wrapper over ssoLogin for callers that cannot block on a terminal
 * prompt (MCP tools). `start()` returns as soon as the flow needs input or
 * finishes; `submitOtp()` / `wait()` return the following step.
 */
export class LoginFlow {
  private nextStep = deferred<LoginStep>();
  private pendingOtp: Deferred<string> | null = null;
  private running = false;
  private lastStep: LoginStep | null = null;

  constructor(private readonly opts: Omit<SsoLoginOptions, "cookies">) {}

  get inProgress(): boolean {
    return this.running;
  }

  get last(): LoginStep | null {
    return this.lastStep;
  }

  async start(creds: { email: string; password: string }): Promise<LoginStep> {
    if (this.running) throw new Error("A login is already in progress");
    this.running = true;
    this.nextStep = deferred<LoginStep>();
    const provider: CredentialProvider = {
      getEmail: async () => creds.email,
      getPassword: async () => creds.password,
      getOtp: (prompt) => {
        this.pendingOtp = deferred<string>();
        this.emit({ state: "otp_required", prompt: summarizePrompt(prompt) });
        return this.pendingOtp.promise;
      },
      onNumberMatch: (number) => {
        this.emit({ state: "number_match", number });
      },
    };
    ssoLogin(provider, this.opts).then(
      (session) => {
        this.running = false;
        this.emit({ state: "done", session });
      },
      (err: unknown) => {
        this.running = false;
        this.pendingOtp?.reject(err);
        this.pendingOtp = null;
        if (err instanceof LoginError) this.emit({ state: "error", code: err.code, message: err.message });
        else this.emit({ state: "error", code: "unknown", message: (err as Error)?.message ?? String(err) });
      },
    );
    return this.wait();
  }

  async submitOtp(code: string): Promise<LoginStep> {
    if (!this.pendingOtp) throw new Error("No login in progress that is waiting for a one-time code");
    const p = this.pendingOtp;
    this.pendingOtp = null;
    this.nextStep = deferred<LoginStep>();
    p.resolve(code);
    return this.wait();
  }

  /** Waits for the next step (e.g. after a number_match was reported). */
  wait(): Promise<LoginStep> {
    return this.nextStep.promise;
  }

  private emit(step: LoginStep) {
    this.lastStep = step;
    const current = this.nextStep;
    this.nextStep = deferred<LoginStep>();
    current.resolve(step);
  }
}

/** Keep the first informative line(s) of the IdP page text; drop boilerplate. */
function summarizePrompt(prompt: string): string {
  const lines = prompt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 3).join(" ") || "Enter the verification code from your authenticator app.";
}
