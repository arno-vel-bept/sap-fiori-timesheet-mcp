import { Command, CommanderError } from "commander";
import type { Readable, Writable } from "node:stream";
import { resolveConfig, type Env } from "../config.js";
import { SessionStore } from "../auth/session-store.js";
import { TerminalCredentialProvider } from "../auth/prompts.js";
import { LoginError, ssoLogin } from "../auth/sso-login.js";
import { SessionManager } from "../auth/session-manager.js";
import { SapClient, SapError, SessionExpiredError } from "../sap/client.js";
import { TimesheetError } from "../timesheet/types.js";
import { registerTimesheetCommands } from "./timesheet-commands.js";
import { registerInstallCommands } from "./install-commands.js";

import { createRequire } from "node:module";
const PKG_VERSION: string = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

/** Exit codes: 0 ok · 1 usage / no session · 2 login rejected · 3 session expired · 4 SAP error */
export const EXIT = { OK: 0, USAGE: 1, LOGIN_FAILED: 2, SESSION_EXPIRED: 3, SAP_ERROR: 4 } as const;

export interface CliIo {
  env?: Env;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
}

/** Runs the CLI with the given argv (without node/script) and returns the exit code. */
export async function runCli(argv: string[], io: CliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = io.stdin ?? process.stdin;
  const out = (s: string) => stdout.write(s + "\n");
  const err = (s: string) => stderr.write(s + "\n");

  let exitCode = 0;
  const program = new Command("xflow-timesheet")
    .description("CLI for the BearingPoint xflow (SAP Fiori) timesheet apps")
    .version(PKG_VERSION, "-v, --version", "print the version")
    .option("--launchpad-url <url>", "Fiori launchpad URL (env XFLOW_LAUNCHPAD_URL)")
    .option("--session-file <path>", "where the login session is stored (env XFLOW_SESSION_FILE)")
    .option("--profile-dir <path>", "persistent browser profile that remembers the identity-provider sign-in (env XFLOW_PROFILE_DIR)")
    .exitOverride()
    .configureOutput({ writeOut: (s) => stdout.write(s), writeErr: (s) => stderr.write(s) });

  const cfg = () => {
    const g = program.opts<{ launchpadUrl?: string; sessionFile?: string; profileDir?: string }>();
    return resolveConfig(env, { launchpadUrl: g.launchpadUrl, sessionFile: g.sessionFile, profileDir: g.profileDir });
  };
  const sessions = () => {
    const c = cfg();
    return new SessionManager({
      launchpadUrl: c.launchpadUrl,
      store: new SessionStore(c.sessionFile),
      profileDir: c.profileDir,
      channel: c.browserChannel,
      language: c.language,
      sapClient: c.sapClient,
      onStatus: (m) => err(`… ${m}`),
    });
  };
  const withSigint = async <T,>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ac = new AbortController();
    const onSigint = () => {
      err(`\nCancelling ${label}…`);
      ac.abort();
    };
    process.once("SIGINT", onSigint);
    try {
      return await fn(ac.signal);
    } finally {
      process.removeListener("SIGINT", onSigint);
    }
  };

  program
    .command("sso")
    .description(
      "Establish a session through the persistent browser profile: silently when the identity provider still remembers this browser, otherwise in a browser window where you sign in yourself (no password passes through the tool)",
    )
    .option("--no-interactive", "never open a window; fail with exit code 3 when a sign-in would be needed")
    .option("--timeout <seconds>", "how long to wait for the sign-in in the window", "240")
    .action(async (o: { interactive: boolean; timeout: string }) => {
      const c = cfg();
      try {
        const res = await withSigint("sign-in", (signal) => {
          const manager = sessions();
          return manager.ensureSession({ interactive: o.interactive, signal });
        });
        const how = { cached: "the stored session is still valid", silent: "renewed silently from the remembered identity", credentials: "signed in with credentials", interactive: "signed in in the browser window" }[res.method];
        out(`Signed in (${res.method}: ${how}). ${res.session.cookies.length} cookie(s) saved to ${c.sessionFile}; identity kept in ${c.profileDir}`);
      } catch (e) {
        if (e instanceof LoginError) {
          err(`Sign-in failed (${e.code}): ${e.message}`);
          exitCode = EXIT.LOGIN_FAILED;
          return;
        }
        throw e;
      }
    });

  program
    .command("login")
    .description("Sign in through the Microsoft SSO with credentials (email, password, 2FA) and store the session cookies locally; the identity-provider sign-in is remembered in the browser profile so `sso` can renew sessions silently later")
    .option("-e, --email <email>", "account email (env XFLOW_EMAIL); prompted if missing")
    .option("-p, --password <password>", "account password (env XFLOW_PASSWORD); prompted (hidden) if missing. Prefer the env var or the prompt.")
    .option("-o, --otp <code>", "one-time code to use if 2FA asks for one; prompted if missing")
    .option("--headed", "show the browser window while logging in", false)
    .option("--timeout <seconds>", "give up after this many seconds", "240")
    .option("--debug-dir <dir>", "on failure, save a screenshot + HTML of the IdP page here")
    .action(async (o: { email?: string; password?: string; otp?: string; headed: boolean; timeout: string; debugDir?: string }) => {
      const c = cfg();
      const creds = new TerminalCredentialProvider({
        email: o.email ?? c.email,
        password: o.password ?? c.password,
        otp: o.otp,
        input: stdin,
        output: stderr,
      });
      try {
        const session = await withSigint("login", (signal) =>
          ssoLogin(creds, {
            launchpadUrl: c.launchpadUrl,
            headless: !o.headed,
            profileDir: c.profileDir,
            channel: c.browserChannel,
            timeoutMs: Number(o.timeout) * 1000,
            debugDir: o.debugDir,
            signal,
          }),
        );
        await new SessionStore(c.sessionFile).save(session);
        out(`Logged in. ${session.cookies.length} cookie(s) saved to ${c.sessionFile}; identity kept in ${c.profileDir}`);
      } catch (e) {
        if (e instanceof LoginError) {
          err(`Login failed (${e.code}): ${e.message}`);
          exitCode = 2;
          return;
        }
        throw e;
      }
    });

  program
    .command("logout")
    .description("Delete the stored SAP session (the identity-provider sign-in stays remembered unless --forget-identity is given)")
    .option("--forget-identity", "also delete the browser profile, so the identity provider asks for a full sign-in next time", false)
    .action(async (o: { forgetIdentity: boolean }) => {
      const c = cfg();
      if (o.forgetIdentity) {
        await sessions().forgetIdentity();
        out(`Session removed (${c.sessionFile}) and identity forgotten (${c.profileDir} deleted)`);
      } else {
        await new SessionStore(c.sessionFile).clear();
        out(`Session removed (${c.sessionFile})`);
      }
    });

  const session = program.command("session").description("Inspect the stored session");
  session
    .command("status")
    .description("Show whether a session is stored and which cookies it holds")
    .action(async () => {
      const c = cfg();
      const data = await new SessionStore(c.sessionFile).load();
      const identity = sessions().hasProfile() ? `Identity remembered in browser profile ${c.profileDir}` : `No browser profile at ${c.profileDir} (identity not remembered; "xflow-timesheet sso" will open a window)`;
      if (!data) {
        out(`No session stored at ${c.sessionFile}. Run "xflow-timesheet sso".`);
        out(identity);
        exitCode = 1;
        return;
      }
      out(`Session for ${data.launchpadUrl}`);
      out(`Created ${data.createdAt}`);
      for (const k of data.cookies) {
        const exp = k.expires && k.expires > 0 ? new Date(k.expires * 1000).toISOString() : "session";
        out(`  ${k.name}  domain=${k.domain}  expires=${exp}`);
      }
      out(identity);
    });

  /**
   * Builds an authenticated client: the stored session is probed and, when expired, renewed silently
   * through the browser profile. Fails with exit code 3 when a sign-in in a window would be needed.
   */
  const client = async (): Promise<SapClient> => {
    const c = cfg();
    const manager = new SessionManager({
      launchpadUrl: c.launchpadUrl,
      store: new SessionStore(c.sessionFile),
      profileDir: c.profileDir,
      channel: c.browserChannel,
      language: c.language,
      sapClient: c.sapClient,
    });
    const { session, method } = await manager.ensureSession({ interactive: false });
    if (method !== "cached") err(`Session renewed (${method}) through the browser profile.`);
    return new SapClient(session, { language: c.language, sapClient: c.sapClient });
  };

  program
    .command("whoami")
    .description("Show the SAP user behind the stored session (checks that the session still works)")
    .action(async () => {
      const sap = await client();
      const me = await sap.getJson<{ id?: string; fullName?: string; client?: string; language?: string; email?: string }>(
        "/sap/bc/ui2/start_up",
      );
      out(`User      ${me.id ?? "?"}`);
      if (me.fullName) out(`Name      ${me.fullName}`);
      if (me.email) out(`Email     ${me.email}`);
      out(`Client    ${me.client ?? "?"}`);
      out(`Language  ${me.language ?? "?"}`);
      out(`Host      ${sap.baseUrl}`);
    });

  const http = program.command("http").description("Raw authenticated HTTP access to the SAP host (exploration / debugging)");
  http
    .command("get <path>")
    .description("GET a path (e.g. /sap/opu/odata/sap/SERVICE/$metadata) and print the response")
    .option("-H, --header <header...>", "extra request header(s) as Name:Value")
    .action(async (path: string, o: { header?: string[] }) => {
      const sap = await client();
      const headers = Object.fromEntries((o.header ?? []).map((h) => h.split(/:\s*/, 2) as [string, string]));
      const wantsJson = !/\$metadata|\.(xml|html|js|css)$/i.test(path);
      if (wantsJson) {
        const json = await sap.getJson(path, headers);
        out(JSON.stringify(json, null, 2));
      } else {
        out(await sap.getText(path, headers));
      }
    });

  registerTimesheetCommands(program, { client, out, err, fail: () => (exitCode = EXIT.SAP_ERROR) });
  registerInstallCommands(program, { env, out, err, cfg, fail: () => (exitCode = EXIT.USAGE) });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof TimesheetError) {
      err(`Error: ${e.message}`);
      return EXIT.SAP_ERROR;
    }
    if (e instanceof SessionExpiredError) {
      err(e.message);
      return EXIT.SESSION_EXPIRED;
    }
    if (e instanceof SapError) {
      err(`SAP error: ${e.message}`);
      return EXIT.SAP_ERROR;
    }
    if (e instanceof CommanderError) {
      // help/version print and exit with 0; usage errors exit with 1
      return e.exitCode === 0 ? 0 : 1;
    }
    err(`Error: ${(e as Error).message}`);
    return 1;
  }
  return exitCode;
}

/** Entry point used by bin/xflow-timesheet.js */
export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}
