/**
 * Daemon-side workflow tools. Read-only tools (glob, read_file, search) are
 * implemented locally, rooted at the workflow's working directory.
 * Mutating tools (write_file, run_bash, git) are approval-gated: the daemon
 * has no interactive approval channel, so they only run when the user's
 * safety config explicitly removes them from requireApprovalFor — otherwise
 * they fail with a clear message (platform plugins mediate approvals).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns/promises';
import { join, resolve, relative, dirname, sep } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 500;
const MAX_REDIRECTS = 5;
const MAX_GLOB_LENGTH = 500;
const MAX_GLOB_WILDCARDS = 16;

// git tool safety: the `git_commit` approval key unblocks the git tool, but a
// commit permission must NOT double as a licence for `git push --force`,
// `git reset --hard`, or arbitrary `-c core.hooksPath=...` config overrides.
// The tool is therefore scoped to a real subcommand allowlist (read-only +
// commit workflow) and rejects everything else, PLUS a few flags that turn an
// allowed subcommand into a destructive/arbitrary-exec one.
const GIT_ALLOWED_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'add', 'commit',
  'branch', 'checkout', 'switch', 'restore', 'stash',
  'rev-parse', 'ls-files', 'blame', 'fetch',
]);
// Flags rejected anywhere in the argv (dashes normalized). `-c`/`--config-env`
// inject arbitrary config (e.g. core.hooksPath, protocol.ext.allow → RCE);
// `--exec`/`--upload-pack`/`--receive-pack` run an arbitrary program; `--hard`
// blows away the worktree; `--force`/`-f` force-push/force-delete.
const GIT_BLOCKED_FLAGS = new Set([
  '-c', '--config-env', '--exec', '--upload-pack', '--receive-pack',
  '--hard', '--force', '-f', '--force-with-lease',
]);

// ── tool manifest ─────────────────────────────────────────────────────────────

/**
 * Model-facing tool contract for agent({tools:[...]}). inputSchema is the JSON
 * Schema the providers send to the model (named properties); argOrder is the
 * positional order createToolExecutor expects — the bridge between the model's
 * named-args calling convention and the executor's positional one. `spread`
 * marks the single array-valued arg that is spread into positionals (git).
 */
export const TOOL_MANIFEST = {
  glob: {
    description: 'List files in the workflow root matching a glob pattern (supports **, *, ? and {a,b}).',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'glob pattern, e.g. src/**/*.js' } }, required: ['pattern'] },
    argOrder: ['pattern'],
  },
  read_file: {
    description: 'Read a UTF-8 text file inside the workflow root and return its contents.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'file path relative to the workflow root' } }, required: ['path'] },
    argOrder: ['path'],
  },
  search: {
    description: 'Search file contents for a case-insensitive regex; returns {file, line, text} matches.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'regular expression to search for' },
        glob: { type: 'string', description: 'optional glob limiting which files are searched (default **/*)' },
      },
      required: ['pattern'],
    },
    argOrder: ['pattern', 'glob'],
  },
  write_file: {
    description: 'Write a UTF-8 text file inside the workflow root, creating parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workflow root' },
        content: { type: 'string', description: 'full file contents to write' },
      },
      required: ['path', 'content'],
    },
    argOrder: ['path', 'content'],
  },
  run_bash: {
    description: 'Run a shell command in the workflow root (bash on POSIX, PowerShell on Windows); returns {stdout, exitCode}.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'the command line to execute' } }, required: ['command'] },
    argOrder: ['command'],
  },
  git: {
    description: 'Run git in the workflow root with the given argument list, e.g. {"args":["status","--short"]}.',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'git arguments, one array element each' } },
      required: ['args'],
    },
    argOrder: ['args'],
    spread: true,
  },
  web_fetch: {
    description: 'Fetch a public http(s) URL and return readable page text (SSRF-guarded).',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'absolute http(s) URL' } }, required: ['url'] },
    argOrder: ['url'],
  },
  web_search: {
    description: 'Keyless web search; returns up to 8 {title, url} results.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'search query' } }, required: ['query'] },
    argOrder: ['query'],
  },
};

/**
 * Provider-neutral tool definitions for a list of manifest names.
 * @param {string[]} names
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
export function toolDefinitionsFor(names) {
  return (names ?? []).map((name) => {
    const spec = TOOL_MANIFEST[name];
    if (!spec) {
      throw new Error(`unknown tool "${name}" — valid tools: ${Object.keys(TOOL_MANIFEST).join(', ')}`);
    }
    return { name, description: spec.description, inputSchema: spec.inputSchema };
  });
}

/**
 * Map the model's named args onto the positional array createToolExecutor
 * expects ({path, content} → ['path','content'] order; git's args array spreads).
 * @param {string} name
 * @param {object} named
 * @returns {any[]}
 */
export function positionalToolArgs(name, named) {
  const spec = TOOL_MANIFEST[name];
  if (!spec) throw new Error(`unknown tool "${name}" — valid tools: ${Object.keys(TOOL_MANIFEST).join(', ')}`);
  const source = named && typeof named === 'object' ? named : {};
  if (spec.spread) {
    const arr = source[spec.argOrder[0]];
    return Array.isArray(arr) ? arr.map(String) : [];
  }
  return spec.argOrder.map((key) => source[key]);
}

// ── SSRF guard ────────────────────────────────────────────────────────────────

/** @returns {boolean} true when the dotted-quad v4 address is private/internal */
function blockedV4(addr) {
  const octets = addr.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||                          // 0.0.0.0/8 "this network"
    a === 10 ||                         // 10/8 private
    a === 127 ||                        // 127/8 loopback
    (a === 169 && b === 254) ||         // 169.254/16 link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||// 172.16/12 private
    (a === 192 && b === 168) ||         // 192.168/16 private
    (a === 100 && b >= 64 && b <= 127) ||// 100.64/10 CGNAT
    (a === 198 && (b === 18 || b === 19)) // 198.18/15 benchmarking
  );
}

/** @returns {boolean} true when the v6 address is private/internal */
function blockedV6(addr) {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]; // strip brackets + zone id
  if (a === '::' || a === '::1') return true;
  // IPv4-mapped: re-check the embedded v4 (dotted form from dns, hex form from the URL parser)
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return blockedV4(dotted[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return blockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(a.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** @returns {boolean} true for hostnames that must never be fetched */
function blockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, ''); // tolerate trailing-dot FQDNs
  return (
    h === 'localhost' || h.endsWith('.localhost') ||
    h === 'metadata.google.internal' || h === 'metadata.goog' ||
    h === 'kubernetes.default.svc' || h.endsWith('.svc.cluster.local')
  );
}

/**
 * Assert a URL is a public http(s) target: scheme-checked, blocked-host-checked,
 * and (for non-IP hostnames) every DNS-resolved address checked against private
 * ranges. TOCTOU DNS-rebinding between this check and the actual fetch is
 * accepted residual risk at this layer.
 * @param {string} url
 * @param {{allowPrivateNetwork?: boolean, lookup?: typeof dnsLookup}} [options]
 * @returns {Promise<URL>}
 */
export async function assertPublicHttpUrl(url, { allowPrivateNetwork, lookup } = {}) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw new Error(`web_fetch: invalid url: ${url}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('web_fetch: url must be http(s)');
  if (allowPrivateNetwork === true) return u; // explicit opt-out (localhost docs servers)
  const host = u.hostname.replace(/^\[|\]$/g, ''); // URL wraps v6 literals in []
  if (blockedHostname(host)) throw new Error(`web_fetch: blocked host: ${host}`);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    // The WHATWG URL parser canonicalizes octal/hex/integer v4 forms to dotted-quad.
    if (blockedV4(host)) throw new Error(`web_fetch: blocked private/internal address: ${host}`);
    return u;
  }
  if (host.includes(':')) {
    if (blockedV6(host)) throw new Error(`web_fetch: blocked private/internal address: ${host}`);
    return u;
  }
  let addresses;
  try {
    addresses = await (lookup ?? dnsLookup)(host, { all: true });
  } catch {
    throw new Error(`web_fetch: cannot resolve host: ${host}`);
  }
  if (!addresses?.length) throw new Error(`web_fetch: cannot resolve host: ${host}`);
  for (const { address } of addresses) {
    if (address.includes(':') ? blockedV6(address) : blockedV4(address)) {
      throw new Error(`web_fetch: host ${host} resolves to a private/internal address (${address})`);
    }
  }
  return u;
}

/**
 * Scope the git tool to a safe subcommand allowlist. Rejects dangerous
 * subcommands (push/reset/clean/rebase/...) and dangerous flags (force/hard/
 * arbitrary -c config overrides/--exec) so that unblocking the git tool for
 * commits can NEVER be escalated into a force-push, hard-reset, or RCE.
 * @param {string[]} args the variadic git argv (already spread from {args:[...]})
 * @returns {string[]} the validated argv
 */
export function assertSafeGitArgs(args) {
  const argv = (Array.isArray(args) ? args : []).map(String);
  // Reject blocked flags FIRST — a global flag like `-c core.hooksPath=...` can
  // sit BEFORE the subcommand, so flag rejection must not depend on where the
  // subcommand-detection heuristic lands. `-c`/`--config-env` inject arbitrary
  // config (RCE via hooks/protocol.ext), `--exec`/`--upload-pack` run an
  // arbitrary program, `--hard`/`--force` are destructive.
  for (const raw of argv) {
    if (!raw.startsWith('-')) continue;
    const flag = raw.split('=', 1)[0]; // normalize `--flag=value` → `--flag`
    if (GIT_BLOCKED_FLAGS.has(flag)) {
      throw new Error(`git: flag "${flag}" is not allowed (force/hard/reset/arbitrary-config are blocked)`);
    }
  }
  // The subcommand is the first token, and it must be on the allowlist. With
  // all blocked flags already rejected, the first token is either the
  // subcommand or a benign global flag (e.g. `--no-pager`); skip leading
  // benign flags to reach the subcommand, but a value-taking `-c` can no longer
  // appear here (it was rejected above).
  const sub = argv.find((a) => !a.startsWith('-'));
  if (!sub) throw new Error('git: no subcommand provided');
  if (!GIT_ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new Error(
      `git: subcommand "${sub}" is not allowed — permitted: ${[...GIT_ALLOWED_SUBCOMMANDS].sort().join(', ')}`
    );
  }
  return argv;
}

/**
 * Reject pathological glob patterns BEFORE they compile into a RegExp.
 * @param {string} pattern
 * @returns {string} the validated pattern
 */
export function validateGlob(pattern) {
  const p = String(pattern ?? '');
  if (p.length > MAX_GLOB_LENGTH) {
    throw new Error(`glob pattern too long: ${p.length} chars (max ${MAX_GLOB_LENGTH})`);
  }
  const wildcards = (p.match(/[*?]/g) ?? []).length;
  if (wildcards > MAX_GLOB_WILDCARDS) {
    throw new Error(`glob pattern too complex: ${wildcards} wildcards (max ${MAX_GLOB_WILDCARDS})`);
  }
  return p;
}

/**
 * @param {{cwd: string, safety: {requireApprovalFor: string[], autoApproveReadOnly: boolean,
 *          dryRun: boolean, blockedCommands?: string[]}, logger?: object}} options
 * @returns {(payload: {tool: string, args: any[]}) => Promise<any>}
 */
export function createToolExecutor(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const safety = options.safety;

  const realRoot = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  })();

  const insideRoot = (p) => {
    const abs = resolve(cwd, p);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error(`path escapes the workflow root: ${p}`);
    }
    // Symlink containment: resolve the deepest existing ancestor and re-check.
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      const real = realpathSync(probe);
      const realRel = relative(realRoot, real);
      if (realRel.startsWith('..') || realRel.includes(`..${sep}`)) {
        throw new Error(`path escapes the workflow root via symlink: ${p}`);
      }
    } catch (error) {
      if (/escapes the workflow root/.test(String(error.message))) throw error;
      // realpath failure on exotic paths: fall through to the lexical check above
    }
    return abs;
  };

  const requireUnattendedApproval = (tool, command) => {
    // allowTestCommands is a deliberately narrow allowlist (EXACT string match
    // on the trimmed command, run_bash only) so test-gated verification can run
    // headless without opening arbitrary shell. It skips ONLY the approval
    // requirement — blockedCommands and dryRun still apply.
    const allowlisted = tool === 'run_bash' && command !== undefined &&
      (safety.allowTestCommands ?? []).includes(String(command).trim());
    if (!allowlisted && safety.requireApprovalFor?.includes(tool)) {
      throw new Error(
        `${tool} requires approval and the daemon has no interactive approval channel. ` +
        `Run this workflow through a platform plugin, or remove "${tool}" from safety.requireApprovalFor in ~/.odw/config.json.`
      );
    }
    if (safety.dryRun) {
      throw new Error(`${tool} skipped: dryRun is enabled`);
    }
  };

  const tools = {
    glob: async (pattern) => globWalk(cwd, String(pattern ?? '**/*')).slice(0, MAX_RESULTS),

    // ── web research (read-only, no approval needed) ──────────────────────────
    web_fetch: async (url) => {
      const u = String(url);
      if (!/^https?:\/\//i.test(u)) throw new Error('web_fetch: url must be http(s)');
      const allowPrivateNetwork = safety.web?.allowPrivateNetwork === true;
      // Manual redirects: every hop's absolute Location goes back through the
      // SSRF guard (redirect:'follow' would skip the re-check on Location).
      let current = u;
      let res;
      for (let hop = 0; ; hop++) {
        await assertPublicHttpUrl(current, { allowPrivateNetwork });
        res = await fetch(current, { headers: { 'user-agent': 'odw-research/1.0' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        if (res.status < 300 || res.status >= 400) break;
        const location = res.headers.get('location');
        if (!location) break;
        if (hop >= MAX_REDIRECTS) throw new Error(`web_fetch: too many redirects (>${MAX_REDIRECTS}) for ${u}`);
        current = new URL(location, current).href; // resolve relative Locations
      }
      if (!res.ok) throw new Error(`web_fetch ${res.status} for ${current}`);
      const html = await res.text();
      // strip scripts/styles/tags → readable text
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { url: u, text: text.slice(0, 8000) };
    },

    web_search: async (query) => {
      // Keyless search via DuckDuckGo's HTML endpoint. Best-effort; returns
      // {title, url, snippet}. If it ever fails, the workflow degrades to
      // model knowledge — the research gate tolerates an empty result.
      const q = encodeURIComponent(String(query));
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        method: 'POST',
        headers: { 'user-agent': 'Mozilla/5.0 (odw-research)', 'content-type': 'application/x-www-form-urlencoded' },
        body: `q=${q}`,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`web_search ${res.status}`);
      const html = await res.text();
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 8) {
        let href = m[1];
        const dd = href.match(/uddg=([^&]+)/);
        if (dd) { try { href = decodeURIComponent(dd[1]); } catch { /* keep */ } }
        const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (title && /^https?:/i.test(href)) out.push({ title, url: href });
      }
      return out;
    },

    read_file: async (path) => {
      const abs = insideRoot(String(path));
      const stats = statSync(abs);
      if (stats.size > MAX_FILE_BYTES) throw new Error(`file too large (${stats.size} bytes > ${MAX_FILE_BYTES})`);
      return readFileSync(abs, 'utf8');
    },

    search: async (pattern, globPattern) => {
      const re = new RegExp(String(pattern), 'i');
      const files = globWalk(cwd, String(globPattern ?? '**/*')).slice(0, MAX_RESULTS);
      const matches = [];
      for (const file of files) {
        let content;
        try {
          const abs = insideRoot(file);
          if (statSync(abs).size > MAX_FILE_BYTES) continue;
          content = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file, line: i + 1, text: lines[i].slice(0, 400) });
            if (matches.length >= MAX_RESULTS) return matches;
          }
        }
      }
      return matches;
    },

    write_file: async (path, content) => {
      requireUnattendedApproval('write_file');
      const abs = insideRoot(String(path));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(content ?? ''), 'utf8');
      return { written: relative(cwd, abs) };
    },

    run_bash: async (command) => {
      const cmd = String(command ?? '');
      requireUnattendedApproval('run_bash', cmd);
      // Case-insensitive: Windows command names (Remove-Item, FORMAT) are
      // case-insensitive, so a case-sensitive guard would be trivially bypassed.
      const lower = cmd.toLowerCase();
      for (const blocked of safety.blockedCommands ?? []) {
        if (lower.includes(String(blocked).toLowerCase())) throw new Error(`blocked command pattern: ${blocked}`);
      }
      const shell = process.platform === 'win32' ? 'powershell' : 'bash';
      const flag = process.platform === 'win32' ? '-Command' : '-c';
      try {
        const stdout = execFileSync(shell, [flag, cmd], { cwd, timeout: 120_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        return { stdout: String(stdout).slice(0, 100_000), exitCode: 0 };
      } catch (e) {
        // A non-zero exit (e.g. a failing test suite) is NOT a tool error — the
        // command's output is the useful signal. Capture stdout+stderr and the
        // exit code so callers (e.g. a fix-until-green loop) can act on it.
        const out = String((e.stdout || '') + (e.stderr || '')).slice(0, 100_000);
        return { stdout: out || String(e.message), exitCode: typeof e.status === 'number' ? e.status : 1, failed: true };
      }
    },

    git: async (...args) => {
      requireUnattendedApproval('git_commit');
      // Scope to the safe subcommand allowlist BEFORE spawning git: the commit
      // approval must never smuggle a `push --force` / `reset --hard` / `-c` RCE.
      const safeArgs = assertSafeGitArgs(args);
      const stdout = execFileSync('git', safeArgs, { cwd, timeout: 60_000, encoding: 'utf8' });
      return { stdout: stdout.slice(0, 100_000) };
    },
  };

  return async ({ tool, args }) => {
    const impl = tools[tool];
    if (!impl) throw new Error(`unknown tool: ${tool}`);
    return impl(...(Array.isArray(args) ? args : []));
  };
}

/** Minimal glob: supports **, *, ? and {a,b} alternation. Skips node_modules/.git. */
export function globWalk(root, pattern) {
  const re = globToRegExp(validateGlob(pattern));
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isDirectory()) walk(abs);
      else if (re.test(rel)) {
        out.push(rel);
        if (out.length >= MAX_RESULTS * 4) return;
      }
    }
  };
  walk(root);
  return out;
}

function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const p = pattern.replace(/\\/g, '/');
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += p[i + 2] === '/' ? 3 : 2;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const alts = p.slice(i + 1, end).split(',').map(escapeRe);
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      re += escapeRe(ch);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
