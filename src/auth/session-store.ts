import { mkdir, readFile, writeFile, unlink, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cookie, CookieJar } from "tough-cookie";

/** A browser cookie in Playwright's shape (also what we persist on disk). */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface SessionData {
  launchpadUrl: string;
  createdAt: string;
  cookies: SessionCookie[];
}

export const DEFAULT_SESSION_FILE =
  process.env.XFLOW_SESSION_FILE ?? join(homedir(), ".config", "xflow-timesheet", "session.json");

/** Persists the authenticated browser cookies on disk (0600) and turns them into Cookie headers. */
export class SessionStore {
  constructor(readonly file: string = DEFAULT_SESSION_FILE) {}

  async load(): Promise<SessionData | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as SessionData;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(data: SessionData): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
    await chmod(this.file, 0o600);
  }

  async clear(): Promise<void> {
    await unlink(this.file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }

  /** Cookie header (`a=1; b=2`) applicable to `url`, or "" when nothing is stored. */
  async cookieHeaderFor(url: string): Promise<string> {
    const data = await this.load();
    if (!data) return "";
    return cookieHeaderFor(data.cookies, url);
  }
}

export function cookieHeaderFor(cookies: SessionCookie[], url: string): string {
  const jar = new CookieJar(undefined, { rejectPublicSuffixes: false, looseMode: true });
  for (const c of cookies) {
    const cookie = new Cookie({
      key: c.name,
      value: c.value,
      domain: c.domain.replace(/^\./, ""),
      path: c.path || "/",
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      hostOnly: !c.domain.startsWith("."),
      expires: c.expires && c.expires > 0 ? new Date(c.expires * 1000) : "Infinity",
    });
    const scheme = c.secure ? "https" : "http";
    jar.setCookieSync(cookie, `${scheme}://${cookie.domain}${cookie.path}`, { ignoreError: true });
  }
  return jar.getCookieStringSync(url);
}
