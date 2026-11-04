import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(
  process.argv[2],
  'Usage: node test/validation-agterm.mjs <new-sandbox> [runtime-root]',
);
const requested = resolve(process.argv[2]);
const sandbox = join(realpathSync(dirname(requested)), basename(requested));
const runtime = realpathSync(resolve(process.argv[3] ?? repo));
assert.ok(
  !existsSync(sandbox) &&
    [repo, runtime].every((root) => {
      const path = relative(root, sandbox);
      return path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
    }),
  'Use a new sandbox outside the source/runtime checkouts.',
);
const packageAt = (path) =>
  JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
const piRoot = join(runtime, 'node_modules/@earendil-works/pi-coding-agent');
const native = join(runtime, 'node_modules/pi-subagents');
const versions = {
  extension: packageAt(runtime).version,
  pi: packageAt(piRoot).version,
  native: packageAt(native).version,
  tui: packageAt(join(runtime, 'node_modules/@earendil-works/pi-tui')).version,
};
assert.equal(versions.pi, '1.5.0');
assert.equal(versions.native, '0.84.0');
assert.equal(versions.tui, '1.5.0');
mkdirSync(sandbox);
for (const path of ['home/.pi/agent', 'native', 'tmp', 'evidence'])
  mkdirSync(join(sandbox, path), { recursive: true });
const home = join(sandbox, 'home');
const agent = join(home, '.pi/agent');
const profiles = ['plan', 'goal', 'fix', 'lifecycle'];
const gitEnv = {
  PATH: process.env.PATH,
  HOME: home,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
for (const profile of profiles) {
  const cwd = join(sandbox, profile);
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Validation Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(
    join(cwd, '.gitignore'),
    '.ralphex/\n.pi-subagents/\nsubagent-artifacts/\n',
  );
  if (profile !== 'goal')
    writeFileSync(
      join(cwd, 'plan.md'),
      '### Task 1: Deliver fixture\n- [ ] Deliver fixture\n',
    );
  writeFileSync(
    join(cwd, 'check.mjs'),
    'import assert from "node:assert/strict";import{readFileSync}from"node:fs";assert.equal(readFileSync("result.txt","utf8"),"done"+String.fromCharCode(10));',
  );
  writeFileSync(
    join(cwd, '.pi/plan-exec.json'),
    JSON.stringify({
      requiredChecks: [[process.execPath, 'check.mjs']],
      reviewEnabled: true,
      reviewRequired: true,
      finalizeEnabled: false,
      statsEnabled: false,
      retryDelayMs: 100,
      workerModel: 'validation/fixture',
      reviewerModel: 'validation/fixture',
      executionLifetime: { mode: 'bounded', timeoutMs: 120000 },
    }),
  );
  git('add', '.');
  git('commit', '-m', 'Validation baseline');
  git('checkout', '-b', 'feature');
}
function shellQuote(value) {
  const q = String.fromCharCode(39);
  return q + value.replaceAll(q, q + String.fromCharCode(92) + q + q) + q;
}
function commandFor(fixing) {
  const script = [
    'const fs=require("node:fs"),cp=require("node:child_process")',
    fixing
      ? 'fs.writeFileSync("review-fixed.txt","reviewed"+String.fromCharCode(10));const files=["review-fixed.txt"]'
      : 'fs.writeFileSync("result.txt","done"+String.fromCharCode(10));const files=["result.txt"];if(fs.existsSync("plan.md")){fs.writeFileSync("plan.md",fs.readFileSync("plan.md","utf8").replace("[ ]","[x]"));files.push("plan.md")}',
    'cp.execFileSync("git",["add","--",...files])',
    'cp.execFileSync("git",["-c","commit.gpgsign=false","commit","-m",' +
      JSON.stringify(fixing ? 'Fix review metadata' : 'Deliver fixture') +
      '])',
  ].join(';');
  return shellQuote(process.execPath) + ' -e ' + shellQuote(script);
}
function reply(res, model, delta, toolCall = false) {
  const chunk = {
    id: 'validation',
    object: 'chat.completion.chunk',
    created: 1,
    model,
  };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' +
      JSON.stringify({
        ...chunk,
        choices: [{ index: 0, delta, finish_reason: null }],
      }) +
      '\n\n',
  );
  res.write(
    'data: ' +
      JSON.stringify({
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: toolCall ? 'tool_calls' : 'stop',
          },
        ],
      }) +
      '\n\n',
  );
  res.end('data: [DONE]\n\n');
}

function profileFor(body) {
  const direct = profiles.find((name) => body.includes(join(sandbox, name)));
  if (direct) return direct;
  const directory = join(home, '.pi/plan-exec/runs');
  if (!existsSync(directory)) return undefined;
  for (const id of readdirSync(directory).filter((value) =>
    /^[a-f0-9-]{36}$/u.test(value),
  )) {
    const file = join(directory, id, 'run.json');
    if (!existsSync(file)) continue;
    const run = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof run.worktreeCwd === 'string' && body.includes(run.worktreeCwd))
      return profiles.find(
        (name) => run.repositoryRoot === join(sandbox, name),
      );
  }
  return undefined;
}

const calls = [];
let held = false;
const pending = new Set();
const lifecycle = (event) =>
  appendFileSync(
    join(sandbox, 'evidence/server.jsonl'),
    JSON.stringify({ at: Date.now(), ...event }) + '\n',
  );
const server = http.createServer((req, res) => {
  if (req.url === '/__hold' && req.method === 'POST') {
    held = true;
    res.end('held');
    return;
  }
  if (req.url === '/__release' && req.method === 'POST') {
    held = false;
    for (const deliver of [...pending]) deliver();
    res.end('released');
    return;
  }
  if (req.url === '/__status') {
    res.end(JSON.stringify({ held, pending: pending.size, calls }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    try {
      const input = JSON.parse(body);
      const tools = (input.tools ?? []).map((tool) => tool.function?.name);
      const reviewer = tools.includes('structured_output');
      const worker = !reviewer && body.includes('You are `worker`');
      const profile = profileFor(body);
      if (!reviewer && !worker) {
        const last = input.messages
          .filter((message) => message.role === 'user')
          .at(-1);
        const text =
          typeof last?.content === 'string'
            ? last.content
            : Array.isArray(last?.content)
              ? last.content.map((part) => part.text ?? '').join('\n')
              : '';
        assert.ok(
          !/^\s*\/(?:exec|goal)\b/u.test(text),
          'A deterministic control command reached the model.',
        );
        const completionWake =
          /Background task (?:completed|failed|stopped|paused|cancelled):/u.test(
            body,
          );
        assert.ok(
          profile &&
            (body.includes('VALIDATION_PARENT_READY') || completionWake),
          'Unexpected parent request.',
        );
        const call = {
          at: Date.now(),
          profile,
          parent: true,
          completionWake,
          model: input.model,
        };
        calls.push(call);
        appendFileSync(
          join(sandbox, 'evidence/model-calls.jsonl'),
          JSON.stringify(call) + '\n',
        );
        reply(res, input.model, {
          role: 'assistant',
          content: call.completionWake
            ? 'Plan-exec owns this work. Its status and inspector report verified progress.'
            : 'Ready for isolated validation.',
        });
        return;
      }
      assert.ok(profile, 'Unknown fixture child target.');
      if (reviewer)
        assert.ok(
          !tools.some((name) => ['bash', 'write', 'edit'].includes(name)),
          'Reviewer must be readonly.',
        );
      const wrote = input.messages.some(
        (message) =>
          message.role === 'tool' &&
          String(message.tool_call_id).startsWith('fixture-write'),
      );
      const fixing = body.includes('sole worker fixing review findings');
      const call = {
        at: Date.now(),
        profile,
        reviewer,
        worker,
        wrote,
        fixing,
        model: input.model,
        tools,
      };
      calls.push(call);
      appendFileSync(
        join(sandbox, 'evidence/model-calls.jsonl'),
        JSON.stringify(call) + '\n',
      );
      let delivered = false;
      const deliver = () => {
        if (delivered) return;
        delivered = true;
        pending.delete(deliver);
        if (res.destroyed) return;
        const commit = /Review exactly commit ([a-f0-9]{40})/u.exec(body)?.[1];
        if (reviewer)
          assert.ok(commit, 'Review must name a full candidate commit.');
        const findings =
          reviewer &&
          profile === 'fix' &&
          !existsSync(join(sandbox, 'fix', 'review-fixed.txt'))
            ? [
                {
                  severity: 'MAJOR',
                  summary: 'Fixture review metadata is missing',
                  evidence: 'review-fixed.txt is absent.',
                  suggestion: 'Add review-fixed.txt.',
                },
              ]
            : [];
        const toolCall = reviewer
          ? {
              name: 'structured_output',
              arguments: JSON.stringify({
                value: { schemaVersion: 1, reviewedCommit: commit, findings },
              }),
            }
          : !wrote
            ? {
                name: 'bash',
                arguments: JSON.stringify({ command: commandFor(fixing) }),
              }
            : undefined;
        const delta = toolCall
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: reviewer ? 'fixture-review' : 'fixture-write',
                  type: 'function',
                  function: toolCall,
                },
              ],
            }
          : {
              role: 'assistant',
              content:
                worker && profile === 'goal'
                  ? '<<<RALPHEX:GOAL_DONE>>>'
                  : 'Task completed and committed.',
            };
        reply(res, input.model, delta, Boolean(toolCall));
      };
      if (held && worker && !wrote) {
        pending.add(deliver);
        res.on('close', () => pending.delete(deliver));
      } else deliver();
    } catch (error) {
      lifecycle({ event: 'request-error', message: String(error) });
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = 'http://127.0.0.1:' + server.address().port;
writeFileSync(
  join(agent, 'models.json'),
  JSON.stringify({
    providers: {
      validation: {
        api: 'openai-completions',
        apiKey: 'local-fixture-only',
        baseUrl: endpoint + '/v1',
        models: [
          {
            id: 'fixture',
            reasoning: false,
            contextWindow: 128000,
            maxTokens: 2048,
          },
        ],
      },
    },
  }),
);
writeFileSync(
  join(agent, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'validation',
    defaultModel: 'fixture',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'always',
    packages: [native, runtime],
    extensions: [join(repo, 'test/fixtures/validation-ui.ts')],
  }),
);
writeFileSync(
  join(sandbox, 'isolate.mjs'),
  'import os from "node:os";import{syncBuiltinESMExports}from"node:module";os.homedir=()=>' +
    JSON.stringify(home) +
    ';syncBuiltinESMExports();',
);
const hash = createHash('sha256');
for (const file of readdirSync(join(runtime, 'src')).sort())
  hash.update(file).update(readFileSync(join(runtime, 'src', file)));
const manifest = {
  schemaVersion: 1,
  sandbox,
  runtime,
  versions,
  endpoint,
  sourceHash: hash.digest('hex'),
  lockHash: createHash('sha256')
    .update(readFileSync(join(runtime, 'package-lock.json')))
    .digest('hex'),
  cli: resolve(piRoot, packageAt(piRoot).bin.pi),
  node: process.execPath,
  gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: runtime,
    encoding: 'utf8',
  }).trim(),
  profiles,
};
writeFileSync(
  join(sandbox, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);
const client = join(sandbox, 'client.mjs');
writeFileSync(
  client,
  [
    'import{spawn}from"node:child_process";import{readFileSync}from"node:fs";import{join}from"node:path";',
    'const root=' +
      JSON.stringify(sandbox) +
      ',m=JSON.parse(readFileSync(join(root,"manifest.json"),"utf8")),profile=process.argv[2];',
    'if(!m.profiles.includes(profile))throw new Error("Unknown validation profile");',
    'const env={PATH:process.env.PATH,HOME:join(root,"home"),TMPDIR:join(root,"tmp"),TERM:process.env.TERM,COLORTERM:process.env.COLORTERM,TERM_PROGRAM:process.env.TERM_PROGRAM,PI_CODING_AGENT_DIR:join(root,"home/.pi/agent"),PI_SUBAGENTS_TEMP_ROOT:join(root,"native"),PI_OFFLINE:"1",NODE_OPTIONS:"--import="+join(root,"isolate.mjs"),NODE_PATH:"",GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1",PLAN_EXEC_VALIDATION_SANDBOX:root,PI_TUI_WRITE_LOG:join(root,"evidence",profile+".ansi.log")};',
    'for(const[k,v]of Object.entries(process.env))if(k.startsWith("AGTERM_")&&v!==undefined)env[k]=v;',
    'const p=spawn(m.node,[m.cli,"--session",join(root,profile+"-session.jsonl")],{cwd:join(root,profile),env,stdio:"inherit"});',
    'p.on("close",code=>{process.exitCode=code??1;});',
  ].join('\n'),
);
lifecycle({ event: 'ready', versions });
console.log('Validation server ready: ' + endpoint);
console.log('Manifest: ' + join(sandbox, 'manifest.json'));
console.log(
  'Client: ' + process.execPath + ' ' + client + ' plan|goal|fix|lifecycle',
);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'])
  process.on(signal, () => {
    lifecycle({ event: 'signal', signal });
    server.closeAllConnections();
    server.close(() => {
      process.exitCode = 0;
    });
  });
