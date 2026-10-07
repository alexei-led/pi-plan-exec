import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const project = resolve('.');
const removed = ['@alexeiled/pi-subagents-bridge', '@tintinweb/pi-tasks'];

async function waitFor(read, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

test('packed normal loader: native plan/goal/review, lost reply, force stop/restart and inert ambient children', {
  timeout: 360000,
}, async () => {
  const sandbox = await realpath(
    await mkdtemp(join(tmpdir(), 'plan-exec-consumer-')),
  );
  const consumer = join(sandbox, 'consumer');
  const home = join(sandbox, 'home');
  const agent = join(home, '.pi', 'agent');
  const temp = join(sandbox, 'tmp');
  await Promise.all([
    mkdir(consumer),
    mkdir(agent, { recursive: true }),
    mkdir(temp),
  ]);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    LANG: 'C',
    LC_ALL: 'C',
    PI_CODING_AGENT_DIR: agent,
    PI_SUBAGENTS_TEMP_ROOT: join(sandbox, 'native'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    NODE_PATH: '',
    NODE_OPTIONS: '',
    PI_OFFLINE: '1',
  };
  let mode = 'plan';
  let hold = false;
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        const tools = (input.tools ?? []).map((tool) => tool.function?.name);
        const reviewer = tools.includes('structured_output');
        const worker = !reviewer && body.includes('You are `worker`');
        const wrote = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            String(message.tool_call_id).startsWith('fixture-write'),
        );
        calls.push({ mode, reviewer, worker, wrote });
        if (hold && worker && !wrote) {
          res.on('close', () => {});
          return;
        }
        const command = `node -e 'const fs=require("node:fs");fs.writeFileSync("result.txt","done\\n");if(fs.existsSync("plan.md"))fs.writeFileSync("plan.md",fs.readFileSync("plan.md","utf8").replace("[ ]","[x]"));' && git add result.txt plan.md && git -c commit.gpgSign=false commit -m 'Deliver fixture'`;
        const commit = /Review exactly commit ([a-f0-9]{40})/.exec(body)?.[1];
        if (reviewer)
          assert.ok(commit, 'Reviewer must be bound to a full commit');
        const findings =
          mode === 'findings' &&
          !existsSync(join(sandbox, mode, 'review-fixed.txt'))
            ? [
                {
                  severity: 'MAJOR',
                  summary: 'Fixture review metadata is missing',
                  evidence:
                    'review-fixed.txt does not exist in the inspected tree.',
                  suggestion: 'Add the required review metadata file.',
                },
              ]
            : [];
        const report = {
          schemaVersion: 1,
          reviewedCommit: mode === 'wrong-commit' ? 'b'.repeat(40) : commit,
          findings,
          ...(mode === 'malformed' ? { unexpected: true } : {}),
        };
        const reviewCalled = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            String(message.tool_call_id).startsWith('fixture-review'),
        );
        const fixing = body.includes('sole worker fixing review findings');
        const fixCommand = `node -e 'require("node:fs").writeFileSync("review-fixed.txt","reviewed\\n")' && git add review-fixed.txt && git -c commit.gpgSign=false commit -m 'Fix review metadata'`;
        const toolCall =
          reviewer &&
          mode !== 'missing' &&
          !(mode === 'malformed' && reviewCalled)
            ? {
                name: 'structured_output',
                arguments: JSON.stringify({ value: report }),
              }
            : worker && !wrote
              ? {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: fixing ? fixCommand : command,
                  }),
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
              content: worker
                ? mode === 'goal'
                  ? '<<<RALPHEX:GOAL_DONE>>>'
                  : 'Task completed and committed.'
                : 'Fixture observation complete.',
            };
        const chunk = {
          id: 'local-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
        };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let host;
  let complete = false;
  let retainUnknownOwnership = false;
  try {
    const packed = await execute(
      'npm',
      [
        'exec',
        '--yes',
        '--package=npm@12.0.2',
        '--',
        'npm',
        'pack',
        '--json',
        '--ignore-scripts',
        '--pack-destination',
        sandbox,
      ],
      { cwd: project, timeout: 60000, maxBuffer: 2000000 },
    );
    const packing = JSON.parse(packed.stdout);
    const tarball = join(
      sandbox,
      (Array.isArray(packing) ? packing[0] : Object.values(packing)[0])
        .filename,
    );
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'isolated-plan-consumer',
        private: true,
        type: 'module',
      }),
    );
    await execute(
      'npm',
      [
        'exec',
        '--yes',
        '--package=npm@12.0.2',
        '--',
        'npm',
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarball,
        'pi-subagents@0.76.1',
        '@earendil-works/pi-coding-agent@1.0.4',
      ],
      { cwd: consumer, env, timeout: 120000, maxBuffer: 2000000 },
    );
    const require = createRequire(join(consumer, 'package.json'));
    const installed = join(consumer, 'node_modules/@alexeiled/pi-plan-exec');
    for (const name of removed) {
      assert.throws(() => require.resolve(name));
      assert.throws(() =>
        createRequire(join(installed, 'src/index.ts')).resolve(name),
      );
    }
    const native = join(consumer, 'node_modules/pi-subagents');
    assert.equal((await json(join(native, 'package.json'))).version, '0.76.1');
    const preload = join(sandbox, 'isolate.mjs');
    await writeFile(
      preload,
      `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';import{EventEmitter}from'node:events';import{appendFileSync,existsSync,unlinkSync,writeFileSync}from'node:fs';import{join}from'node:path';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();
const root=${JSON.stringify(sandbox)},original=EventEmitter.prototype.emit;let dropped;
EventEmitter.prototype.emit=function(name,value,...rest){if(process.env.PI_SUBAGENT_CHILD!=='1'){if(name==='subagents:rpc:v1:request'&&value?.method==='spawn'){appendFileSync(join(root,'spawns.jsonl'),JSON.stringify({pid:process.pid,requestId:value.requestId})+'\\n');if(existsSync(join(root,'drop-next'))){unlinkSync(join(root,'drop-next'));dropped=value.requestId;}}if(dropped&&name==='subagents:rpc:v1:reply:'+dropped){writeFileSync(join(root,'dropped.json'),JSON.stringify({requestId:dropped}));dropped=undefined;return false;}}return original.call(this,name,value,...rest);};`,
    );
    env.NODE_OPTIONS = `--import=${preload}`;
    const observer = join(sandbox, 'observer.mjs');
    await writeFile(
      observer,
      `import{appendFileSync,existsSync,readFileSync,readdirSync,unlinkSync,writeFileSync}from'node:fs';import{join}from'node:path';
export default function(pi){
 const root=${JSON.stringify(sandbox)},home=${JSON.stringify(home)};
 pi.on('session_start',(_event,ctx)=>{const dir=join(home,'.pi','plan-exec','runs');const leases=existsSync(dir)?readdirSync(dir).filter(id=>!id.startsWith('.')).flatMap(id=>{try{const r=JSON.parse(readFileSync(join(dir,id,'run.json'),'utf8'));return r.lease?[{id,pid:r.lease.pid,sessionId:r.lease.sessionId}]:[];}catch{return[];}}):[];appendFileSync(join(root,'loads.jsonl'),JSON.stringify({pid:process.pid,child:process.env.PI_SUBAGENT_CHILD==='1',commands:pi.getCommands().map(c=>c.name),sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile(),leases})+'\\n');});
}`,
    );
    await writeFile(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          localfixture: {
            api: 'openai-completions',
            apiKey: 'local-only',
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
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
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'localfixture',
        defaultModel: 'fixture',
        defaultThinkingLevel: 'off',
        defaultProjectTrust: 'always',
        packages: [native, installed],
        extensions: [observer],
      }),
    );
    const cli = join(
      consumer,
      'node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    );
    const runs = join(home, '.pi/plan-exec/runs');
    async function listRuns() {
      try {
        return (
          await Promise.all(
            (
              await readdir(runs)
            )
              .filter((id) => /^[0-9a-f-]{36}$/.test(id))
              .map((id) => json(join(runs, id, 'run.json'))),
          )
        ).filter(Boolean);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    }
    async function launch(cwd, session) {
      const child = spawn(
        process.execPath,
        [cli, '--mode', 'rpc', '--session', session],
        { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const output = [];
      let buffer = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            output.push(JSON.parse(line));
          } catch {}
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const exited = once(child, 'close');
      const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
      send({ id: 'commands', type: 'get_commands' });
      await waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(stderr);
          return output.some(
            (v) =>
              v.id === 'commands' &&
              v.data?.commands?.some((c) => c.name === 'exec'),
          );
        },
        `normal loader registers commands: ${cwd}`,
        30000,
      );
      return {
        child,
        output,
        stderr: () => stderr,
        send,
        async close() {
          child.kill('SIGTERM');
          await Promise.race([
            exited,
            new Promise((_, reject) =>
              setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('Parent fixture shutdown timed out'));
              }, 10000).unref(),
            ),
          ]);
        },
      };
    }
    for (mode of [
      'plan',
      'goal',
      'findings',
      'wrong-commit',
      'malformed',
      'missing',
      'stop',
    ]) {
      const cwd = join(sandbox, mode);
      await mkdir(join(cwd, '.pi'), { recursive: true });
      const git = (args) => execute('git', args, { cwd, env });
      await git(['init', '-b', 'main']);
      await git(['config', 'user.name', 'Consumer Fixture']);
      await git(['config', 'user.email', 'fixture@example.test']);
      await git(['config', 'commit.gpgSign', 'false']);
      await git(['config', 'core.hooksPath', '/dev/null']);
      await writeFile(
        join(cwd, 'plan.md'),
        '### Task 1: Deliver fixture\n- [ ] Deliver fixture\n',
      );
      await writeFile(
        join(cwd, 'check.mjs'),
        `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync('result.txt','utf8'),'done\\n');`,
      );
      await writeFile(
        join(cwd, '.pi/plan-exec.json'),
        JSON.stringify({
          reviewEnabled: true,
          reviewRequired: true,
          finalizeEnabled: false,
          statsEnabled: false,
          retryDelayMs: 100,
          workerModel: 'localfixture/fixture',
          reviewerModel: 'localfixture/fixture',
          executionLifetime: { mode: 'bounded', timeoutMs: 60000 },
          requiredChecks: [[process.execPath, 'check.mjs']],
        }),
      );
      await git(['add', '.']);
      await git(['commit', '-m', 'Fixture baseline']);
      await git(['checkout', '-b', 'feature']);
      const session = join(sandbox, `${mode}-session.jsonl`);
      host = await launch(cwd, session);
      if (mode === 'plan') await writeFile(join(sandbox, 'drop-next'), 'drop');
      hold = mode === 'stop';
      host.send({
        id: 'start',
        type: 'prompt',
        message:
          mode === 'goal'
            ? '/goal Deliver fixture'
            : `/exec --worktree ${cwd} plan.md`,
      });
      const run = await waitFor(
        async () => (await listRuns()).find((r) => r.repositoryRoot === cwd),
        `create ${mode}`,
      );
      if (['wrong-commit', 'malformed', 'missing'].includes(mode)) {
        const rejected = await waitFor(
          async () => {
            const current = await json(join(runs, run.id, 'run.json'));
            return (
              current?.error &&
              current.stage === 'comprehensive_review' &&
              current
            );
          },
          `reject ${mode}`,
          60000,
        );
        assert.notEqual(rejected.status, 'completed');
        assert.equal(rejected.reviewedCommit, undefined);
        host.send({
          id: 'reject-stop',
          type: 'prompt',
          message: `/exec stop ${run.id} --force`,
        });
        await waitFor(async () => {
          const current =
            (await json(join(runs, run.id, 'run.json'))) ??
            (await json(join(runs, '.abandoned', run.id, 'run.json')));
          return current?.status === 'abandoned';
        }, 'stop rejected report');
      } else if (mode !== 'stop') {
        const completed = await waitFor(
          async () => {
            const current = await json(join(runs, run.id, 'run.json'));
            if (
              current?.needsAttention &&
              current.error &&
              ['paused', 'failed'].includes(current.status)
            )
              throw new Error(JSON.stringify(current));
            return current?.status === 'completed' && current;
          },
          `complete ${mode}`,
          90000,
        );
        assert.equal(completed.reviewFindings.length, 0);
        assert.equal(completed.config.reviewerAgent, 'plan-exec-reviewer');
        const evidenceDirs = await readdir(join(runs, run.id, 'native'));
        assert.equal(
          evidenceDirs.length,
          mode === 'findings' ? 4 : 2,
          'Only the required worker/review/fix operations, including lost-reply recovery',
        );
        for (const id of evidenceDirs) {
          const evidence = await json(
            join(runs, run.id, 'native', id, 'controller-result.json'),
          );
          if (evidence.result.structuredOutput !== undefined) {
            assert.deepEqual(
              JSON.parse(await readFile(evidence.result.outputPath, 'utf8')),
              evidence.result.structuredOutput,
            );
            assert.equal(evidence.result.structuredOutput.schemaVersion, 1);
          }
          assert.equal(evidence.result.envelope.steps[0].async, true);
          assert.equal(evidence.proof.children.length, 1);
          assert.equal(
            evidence.proof.children[0].runId,
            evidence.result.childRunId,
          );
        }
      } else {
        await waitFor(
          async () =>
            (await json(join(runs, run.id, 'run.json')))?.activeOperation
              ?.externalRunId,
          'bound worker before force stop',
        );
        host.send({
          id: 'stop',
          type: 'prompt',
          message: `/exec stop ${run.id} --force`,
        });
        const abandoned = await waitFor(async () => {
          const current =
            (await json(join(runs, run.id, 'run.json'))) ??
            (await json(join(runs, '.abandoned', run.id, 'run.json')));
          return current?.status === 'abandoned' && current;
        }, 'durable abandonment');
        assert.equal(abandoned.userStopped, true);
        assert.ok(await json(join(runs, '.abandoned', run.id, 'before.json')));
        await waitFor(
          () =>
            host.output.some(
              (value) =>
                typeof value.message === 'string' &&
                value.message.includes('abandoned permanently'),
            ),
          'force-stop outcome',
          15000,
        );
        const settled =
          (await json(join(runs, run.id, 'run.json'))) ??
          (await json(join(runs, '.abandoned', run.id, 'run.json')));
        if (
          !settled?.activeOperation?.processTreeExited &&
          !settled?.activeOperation?.launchFenced
        ) {
          retainUnknownOwnership = true;
          assert.equal(settled.status, 'abandoned');
          assert.equal(
            settled.activeOperation.operationId,
            abandoned.activeOperation.operationId,
          );
          assert.equal(
            settled.activeOperation.requestDigest,
            abandoned.activeOperation.requestDigest,
          );
          assert.equal(settled.lease, undefined);
        }
        await host.close();
        host = undefined;
        const before = await readFile(join(sandbox, 'spawns.jsonl'), 'utf8');
        host = await launch(cwd, session);
        await new Promise((r) => setTimeout(r, 2200));
        assert.equal(
          await readFile(join(sandbox, 'spawns.jsonl'), 'utf8'),
          before,
          'Reload cannot revive an abandoned run',
        );
        const retained = await json(join(runs, run.id, 'run.json'));
        if (retained) {
          assert.equal(retained.status, 'abandoned');
          assert.equal(retained.lease, undefined);
        }
      }
      await host.close();
      host = undefined;
    }
    const loads = (await readFile(join(sandbox, 'loads.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse);
    const children = loads.filter((value) => value.child);
    assert.ok(
      children.length >= 4,
      'Real ambient child extension loading occurred',
    );
    for (const child of children) {
      assert.equal(child.commands.includes('exec'), false);
      assert.equal(child.commands.includes('goal'), false);
      assert.ok(
        child.leases.every(
          (lease) =>
            lease.pid !== child.pid && lease.sessionId !== child.sessionId,
        ),
        'Children never take parent leases',
      );
    }
    assert.ok(await json(join(sandbox, 'dropped.json')));
    assert.ok(
      calls.some((call) => call.worker) && calls.some((call) => call.reviewer),
    );
    complete = true;
  } finally {
    await host?.close();
    server.closeAllConnections();
    server.close();
    if (complete && !retainUnknownOwnership)
      await rm(sandbox, { recursive: true, force: true });
    else
      console.error(
        `Retained isolated packed-consumer evidence${retainUnknownOwnership ? ' (unknown retirement remains reserved)' : ''}: ${sandbox}`,
      );
  }
});
