#!/usr/bin/env node

const ENV = {
  baseUrl: 'VPA_DESKTOP_DRIVER_BASE_URL',
  sessionId: 'VPA_DESKTOP_DRIVER_SESSION_ID',
  token: 'VPA_DESKTOP_DRIVER_TOKEN',
};

const HELP = `Usage:
  node scripts/vpa-desktop-driver.mjs inspect
  node scripts/vpa-desktop-driver.mjs screenshot
  node scripts/vpa-desktop-driver.mjs click --element <index>
  node scripts/vpa-desktop-driver.mjs set-value --element <index> --value <text>
  node scripts/vpa-desktop-driver.mjs type-text --value <text>
  node scripts/vpa-desktop-driver.mjs press-key --key <Tab|Return|Escape|Left|Right|Up|Down|space>

Connection details are read only from VPA_DESKTOP_DRIVER_BASE_URL,
VPA_DESKTOP_DRIVER_SESSION_ID, and VPA_DESKTOP_DRIVER_TOKEN.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function requiredEnvironment() {
  const baseUrlValue = process.env[ENV.baseUrl];
  const sessionId = process.env[ENV.sessionId];
  const token = process.env[ENV.token];
  if (!baseUrlValue || !sessionId || !token) {
    throw new Error('VPA desktop driver environment is incomplete');
  }
  const baseUrl = new URL(baseUrlValue);
  const hostname = baseUrl.hostname.toLowerCase();
  if (baseUrl.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash) {
    throw new Error('VPA desktop driver base URL must be a plain loopback HTTP URL');
  }
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('VPA desktop driver session ID is invalid');
  if (/\s/.test(token) || token.length > 200) throw new Error('VPA desktop driver capability is invalid');
  return { baseUrl, sessionId, token };
}

function option(args, name, { required = true } = {}) {
  const index = args.indexOf(name);
  if (index === -1) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (args.indexOf(name, index + 1) !== -1 || index + 1 >= args.length) {
    throw new Error(`${name} must be provided exactly once`);
  }
  return args[index + 1];
}

function parseCommand(argv) {
  const [command, ...args] = argv;
  if (!command) throw new Error('A desktop driver command is required');
  if (command === 'inspect') {
    if (args.length) throw new Error('inspect does not accept options');
    return { method: 'GET', endpoint: 'inspect' };
  }
  if (command === 'screenshot') {
    if (args.length) throw new Error('screenshot does not accept options');
    return { method: 'POST', endpoint: 'screenshot' };
  }
  if (command === 'click') {
    const element = option(args, '--element');
    if (args.length !== 2 || !/^\d+$/.test(element)) throw new Error('click requires one non-negative --element index');
    return { method: 'POST', endpoint: 'action', body: { kind: 'click', elementIndex: Number(element) } };
  }
  if (command === 'set-value') {
    const element = option(args, '--element');
    const value = option(args, '--value');
    if (args.length !== 4 || !/^\d+$/.test(element)) throw new Error('set-value requires one --element and one --value');
    return { method: 'POST', endpoint: 'action', body: { kind: 'set-value', elementIndex: Number(element), value } };
  }
  if (command === 'type-text') {
    const value = option(args, '--value');
    if (args.length !== 2) throw new Error('type-text requires one --value');
    return { method: 'POST', endpoint: 'action', body: { kind: 'type-text', value } };
  }
  if (command === 'press-key') {
    const key = option(args, '--key');
    if (args.length !== 2 || !['Tab', 'Return', 'Escape', 'Left', 'Right', 'Up', 'Down', 'space'].includes(key)) {
      throw new Error('press-key requires one allowed --key');
    }
    return { method: 'POST', endpoint: 'action', body: { kind: 'press-key', key } };
  }
  throw new Error(`Unknown desktop driver command: ${command}`);
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  let connection;
  try {
    connection = requiredEnvironment();
    const command = parseCommand(process.argv.slice(2));
    const path = `/internal/agent-recording/driver/${encodeURIComponent(connection.sessionId)}/${command.endpoint}`;
    const url = new URL(path, connection.baseUrl);
    const response = await fetch(url, {
      method: command.method,
      headers: {
        authorization: `Bearer ${connection.token}`,
        ...(command.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(command.body ? { body: JSON.stringify(command.body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); }
    catch { throw new Error(`VPA desktop driver returned HTTP ${response.status} with malformed JSON`); }
    if (!response.ok) {
      const diagnostic = typeof result?.error === 'string' ? result.error : `HTTP ${response.status}`;
      throw new Error(`VPA desktop driver request failed: ${diagnostic}`);
    }
    const output = JSON.stringify(result, null, 2).replaceAll(connection.token, '[REDACTED]');
    process.stdout.write(`${output}\n`);
  } catch (error) {
    // Defense in depth: the token is never an argument or URL, and any
    // unexpected server diagnostic is scrubbed before printing.
    const raw = error instanceof Error ? error.message : String(error);
    const safe = connection?.token ? raw.replaceAll(connection.token, '[REDACTED]') : raw;
    fail(safe);
  }
}

await main();
