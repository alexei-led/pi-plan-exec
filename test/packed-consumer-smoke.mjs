import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('packed normal loader: native execution, recovery, readonly controls, supervisor reload and pinned-executor cutover', {
  timeout: 600000,
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
  let supervisorReply = false;
  let releaseSupervisorChild = false;
  let supervisorReturned = false;
  let supervisorReplyOutcome;
  let readonlyRefusal = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
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
        calls.push({
          mode,
          reviewer,
          worker,
          wrote,
          tools,
          model: input.model,
          at: Date.now(),
        });
        if (reviewer) {
          assert.ok(
            !tools.includes('bash') &&
              !tools.includes('write') &&
              !tools.includes('edit'),
            'Readonly reviewer effective tool set',
          );
          assert.ok(
            tools.includes('structured_output'),
            'Required schema tool is actually available',
          );
        }
        const contactCalled = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            String(message.tool_call_id).startsWith('fixture-contact'),
        );
        if (mode === 'supervisor' && !worker && !reviewer) {
          const reply = input.messages.find(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'fixture-supervisor-reply',
          );
          if (reply) supervisorReplyOutcome = JSON.stringify(reply);
        }
        if (mode === 'supervisor' && worker && contactCalled) {
          supervisorReturned = body.includes('FINAL_PROBE_S25_REPLY');
          while (!releaseSupervisorChild && !res.destroyed)
            await new Promise((resolve) => setTimeout(resolve, 20));
          if (res.destroyed) return;
        }
        const forbiddenCalled = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            String(message.tool_call_id).startsWith('fixture-forbidden'),
        );
        if (mode === 'tool-ceiling' && reviewer && forbiddenCalled) {
          assert.match(
            body,
            /not found|not available|not allowed|unknown tool/i,
          );
          readonlyRefusal = true;
        }
        if (hold && worker && !wrote) {
          res.on('close', () => {});
          return;
        }
        let command = `node -e 'const fs=require("node:fs");fs.writeFileSync("result.txt","done\\n");if(fs.existsSync("plan.md"))fs.writeFileSync("plan.md",fs.readFileSync("plan.md","utf8").replace("[ ]","[x]"));' && git add result.txt plan.md && git -c commit.gpgSign=false commit -m 'Deliver fixture'`;
        if (mode === 'cutover')
          command =
            'npm exec --yes --package=npm@12.0.2 -- npm uninstall --ignore-scripts @alexeiled/pi-subagents-bridge @tintinweb/pi-tasks && ' +
            command.replace(
              'git add result.txt plan.md',
              'git add result.txt plan.md package.json package-lock.json',
            );
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
        let toolId;
        let special;
        if (mode === 'supervisor' && worker && !contactCalled) {
          special = {
            name: 'contact_supervisor',
            arguments: JSON.stringify({
              reason: 'need_decision',
              message:
                'FINAL_PROBE_S25: wait for the retained reply before doing any work.',
            }),
          };
          toolId = 'fixture-contact';
        } else if (
          mode === 'supervisor' &&
          !worker &&
          !reviewer &&
          supervisorReply &&
          !input.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'fixture-supervisor-reply',
          )
        ) {
          const request = await json(join(sandbox, 'supervisor-request.json'));
          assert.ok(request?.requestId);
          special = {
            name: 'subagent_supervisor',
            arguments: JSON.stringify({
              action: 'reply',
              replyTo: request.requestId,
              message:
                'FINAL_PROBE_S25_REPLY: proceed once on the original child.',
            }),
          };
          toolId = 'fixture-supervisor-reply';
        } else if (mode === 'tool-ceiling' && reviewer && !forbiddenCalled) {
          special = {
            name: 'write',
            arguments: JSON.stringify({
              path: join(sandbox, mode, 'forbidden-review-write'),
              content: 'must not execute',
            }),
          };
          toolId = 'fixture-forbidden';
        }
        const toolCall =
          special ??
          (reviewer &&
          mode !== 'missing' &&
          !(mode === 'malformed' && reviewCalled)
            ? {
                name: 'structured_output',
                arguments: JSON.stringify({ value: report }),
              }
            : worker &&
                !wrote &&
                !(mode === 'supervisor' && contactCalled && !supervisorReturned)
              ? {
                  name: 'bash',
                  arguments: JSON.stringify({
                    command: fixing ? fixCommand : command,
                  }),
                }
              : undefined);
        const delta = toolCall
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: toolId ?? (reviewer ? 'fixture-review' : 'fixture-write'),
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
          model: input.model,
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
      assert.equal(existsSync(join(consumer, 'node_modules', name)), false);
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
EventEmitter.prototype.emit=function(name,value,...rest){if(process.env.PI_SUBAGENT_CHILD!=='1'){if(name==='subagents:rpc:v1:request'&&value?.method==='stop')appendFileSync(join(root,'stops.jsonl'),JSON.stringify({pid:process.pid,runId:value.params?.id})+'\\n');if(name==='subagents:rpc:v1:request'&&value?.method==='spawn'){appendFileSync(join(root,'spawns.jsonl'),JSON.stringify({pid:process.pid,requestId:value.requestId})+'\\n');if(existsSync(join(root,'drop-next'))){unlinkSync(join(root,'drop-next'));dropped=value.requestId;}}if(dropped&&name==='subagents:rpc:v1:reply:'+dropped){writeFileSync(join(root,'dropped.json'),JSON.stringify({requestId:dropped,runId:value?.data?.details?.workflowChildren?.workflowRunId}));dropped=undefined;return false;}}return original.call(this,name,value,...rest);};`,
    );
    env.NODE_OPTIONS = `--import=${preload}`;
    const observer = join(sandbox, 'observer.mjs');
    await writeFile(
      observer,
      `import { registerSubagentCapabilityCeiling, resolveCurrentSubagentCapabilityCeiling } from ${JSON.stringify(require.resolve('pi-subagents/capability-ceiling'))};
import { resolveSubagentLaunchContract } from ${JSON.stringify(require.resolve('pi-subagents/preflight'))};
import{appendFileSync,existsSync,readFileSync,readdirSync,unlinkSync,writeFileSync}from'node:fs';import{join}from'node:path';
export default function(pi){
 const root=${JSON.stringify(sandbox)},home=${JSON.stringify(home)};
 if(process.env.PI_SUBAGENT_CHILD!=='1'){pi.events.on('pi-intercom:detach-request',value=>writeFileSync(join(root,'supervisor-request.json'),JSON.stringify(value)));pi.events.on('pi-intercom:detach-response',value=>writeFileSync(join(root,'supervisor-detach.json'),JSON.stringify(value)));}
 pi.on('session_start',(_event,ctx)=>{if(process.env.PI_SUBAGENT_CHILD!=='1'&&ctx.cwd.endsWith('/schema-ceiling'))registerSubagentCapabilityCeiling({sessionId:ctx.sessionManager.getSessionFile()??ctx.sessionManager.getSessionId(),source:'final-probe',ceiling:{allowedTools:['read','grep','find','ls']}});});
 pi.on('session_start',(_event,ctx)=>{if(process.env.PI_SUBAGENT_CHILD!=='1'&&ctx.cwd.endsWith('/agent-ceiling'))registerSubagentCapabilityCeiling({sessionId:ctx.sessionManager.getSessionFile()??ctx.sessionManager.getSessionId(),source:'agent-ceiling-probe',ceiling:{allowedAgents:['worker']}});});
 pi.on('session_start',async(_event,ctx)=>{if(process.env.PI_SUBAGENT_CHILD!=='1'&&['/missing-skill','/lazy-skill'].some(name=>ctx.cwd.endsWith(name))){if(ctx.cwd.endsWith('/lazy-skill'))registerSubagentCapabilityCeiling({sessionId:ctx.sessionManager.getSessionFile()??ctx.sessionManager.getSessionId(),source:'skill-probe',ceiling:{allowedTools:['grep','find','ls']}});const result=await resolveSubagentLaunchContract({agent:'skill-probe',task:'Skill admission probe',cwd:ctx.cwd,context:'fresh',sessionRoot:join(root,'skill-preflight'),parentSessionId:ctx.sessionManager.getSessionId(),capabilityCeiling:resolveCurrentSubagentCapabilityCeiling(ctx.sessionManager.getSessionFile()??ctx.sessionManager.getSessionId()),availableModels:ctx.modelRegistry.getAvailable(),runtimeSnapshotHost:pi});writeFileSync(join(ctx.cwd,'..',ctx.cwd.endsWith('/lazy-skill')?'lazy-skill-preflight.json':'missing-skill-preflight.json'),JSON.stringify(result));}});
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
            models: ['fixture', 'scoped-fixture'].map((id) => ({
              id,
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 2048,
            })),
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
    async function executorFingerprint() {
      const hash = createHash('sha256');
      for (const file of (await readdir(join(installed, 'src'))).sort()) {
        hash.update(file).update(await readFile(join(installed, 'src', file)));
      }
      return hash.digest('hex');
    }
    const executorHash = await executorFingerprint();
    const executorTarballHash = createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex');
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
        [
          cli,
          '--mode',
          'rpc',
          '--session',
          session,
          ...(mode === 'valid-skill'
            ? ['--models', 'localfixture/fixture,localfixture/scoped-fixture']
            : []),
        ],
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
    const scenarios = process.env.PLAN_EXEC_PACKED_SCENARIOS?.split(',') ?? [
      'no-peer',
      'plan',
      'goal',
      'findings',
      'wrong-commit',
      'malformed',
      'missing',
      'stop',
      'tool-ceiling',
      'missing-agent',
      'schema-ceiling',
      'agent-ceiling',
      'owned-collision',
      'missing-skill',
      'valid-skill',
      'lazy-skill',
      'deadline',
      'supervisor',
      'cutover',
    ];
    for (mode of scenarios) {
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
        `import assert from 'node:assert/strict';
import{readFileSync}from'node:fs';assert.equal(readFileSync('result.txt','utf8'),'done\\n');`,
      );
      await writeFile(join(cwd, '.gitignore'), 'node_modules/\n');
      if (['missing-skill', 'valid-skill', 'lazy-skill'].includes(mode)) {
        await mkdir(join(cwd, '.pi/agents'), { recursive: true });
        await writeFile(
          join(cwd, '.pi/agents/skill-probe.md'),
          '---\nname: skill-probe\ndescription: Deterministic skill admission probe\ntools: bash, read\ninheritSkills: false\nskills: fixture-private-skill\n---\nYou are `worker`. Deliver the fixture exactly once.\n',
        );
        if (mode !== 'missing-skill') {
          await mkdir(join(cwd, '.pi/skills/fixture-private-skill'), {
            recursive: true,
          });
          await writeFile(
            join(cwd, '.pi/skills/fixture-private-skill/SKILL.md'),
            '---\nname: fixture-private-skill\ndescription: Fixture lazy skill requiring read\n---\nInspect this file before work.\n',
          );
        }
      }
      if (mode === 'valid-skill')
        await writeFile(
          join(cwd, '.pi/settings.json'),
          JSON.stringify({
            subagents: {
              modelScope: { enforce: true, strict: true, allow: ['scoped'] },
            },
          }),
        );
      if (mode === 'owned-collision') {
        await mkdir(join(cwd, '.pi/agents'), { recursive: true });
        await writeFile(
          join(cwd, '.pi/agents/plan-exec-reviewer.md'),
          '---\nname: plan-exec-reviewer\ndescription: Unacceptable configured substitute\ntools: read\n---\nDo not substitute this definition.\n',
        );
      }
      if (
        ['schema-ceiling', 'owned-collision', 'agent-ceiling'].includes(mode)
      ) {
        await writeFile(join(cwd, 'result.txt'), 'done\n');
        await writeFile(
          join(cwd, 'plan.md'),
          '### Task 1: Deliver fixture\n- [x] Deliver fixture\n',
        );
      }
      if (mode === 'cutover') {
        await writeFile(
          join(cwd, 'package.json'),
          JSON.stringify({
            name: 'disposable-migration-target',
            private: true,
            version: '0.0.0',
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
            '@alexeiled/pi-subagents-bridge@0.5.5',
            '@tintinweb/pi-tasks@0.9.0',
          ],
          { cwd, env, timeout: 120000, maxBuffer: 2000000 },
        );
        for (const [name, version] of [
          [removed[0], '0.5.5'],
          [removed[1], '0.9.0'],
        ])
          assert.equal(
            (await json(join(cwd, 'node_modules', name, 'package.json')))
              .version,
            version,
          );
        await writeFile(
          join(cwd, 'check.mjs'),
          `import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{createRequire}from'node:module';const r=createRequire(import.meta.url);assert.equal(readFileSync('result.txt','utf8'),'done\\n');for(const name of ${JSON.stringify(removed)})assert.throws(()=>r.resolve(name));`,
        );
      }
      await writeFile(
        join(cwd, '.pi/plan-exec.json'),
        JSON.stringify({
          reviewEnabled: true,
          reviewRequired: true,
          finalizeEnabled: false,
          statsEnabled: false,
          retryDelayMs: [
            'deadline',
            'missing-agent',
            'lazy-skill',
            'schema-ceiling',
            'supervisor',
          ].includes(mode)
            ? 30000
            : 100,
          ...(mode === 'missing-agent'
            ? { workerAgent: 'intentionally-missing-configured-agent' }
            : {}),
          ...(['missing-skill', 'valid-skill', 'lazy-skill'].includes(mode)
            ? { workerAgent: 'skill-probe' }
            : {}),
          workerModel:
            mode === 'valid-skill'
              ? 'localfixture/scoped-fixture'
              : 'localfixture/fixture',
          reviewerModel:
            mode === 'valid-skill' ? 'inherit' : 'localfixture/fixture',
          executionLifetime: {
            mode: 'bounded',
            timeoutMs: mode === 'deadline' ? 8000 : 60000,
          },
          requiredChecks: [[process.execPath, 'check.mjs']],
        }),
      );
      await git(['add', '.']);
      await git(['commit', '-m', 'Fixture baseline']);
      await git(['checkout', '-b', 'feature']);
      const session = join(sandbox, `${mode}-session.jsonl`);
      if (mode === 'no-peer') {
        const settingsPath = join(agent, 'settings.json');
        const settings = await readFile(settingsPath, 'utf8');
        const hidden = join(sandbox, 'temporarily-absent-native-peer');
        await rename(native, hidden);
        try {
          await writeFile(
            settingsPath,
            JSON.stringify({
              ...JSON.parse(settings),
              packages: [installed],
              extensions: [],
            }),
          );
          host = await launch(cwd, session);
          host.send({
            id: 'no-peer-start',
            type: 'prompt',
            message: `/exec --worktree ${cwd} plan.md`,
          });
          const held = await waitFor(async () => {
            const run = (await listRuns()).find(
              (run) => run.repositoryRoot === cwd,
            );
            return run?.tasks?.['1']?.state === 'waiting_external' && run;
          }, 'bounded optional-peer prerequisite');
          assert.equal(
            calls.some((call) => call.mode === mode),
            false,
          );
          assert.equal(held.tasks['1'].attempts, 0);
          assert.equal(held.activeOperation, undefined);
          assert.match(held.tasks['1'].reason, /Native runtime unavailable/);
          console.log(
            JSON.stringify({
              scenario: 'optional peer absent',
              commandsRegistered: true,
              prerequisite: held.tasks['1'].externalPrerequisite,
              modelCalls: 0,
            }),
          );
          host.send({
            id: 'no-peer-stop',
            type: 'prompt',
            message: `/exec stop ${held.id} --force`,
          });
          await waitFor(
            async () =>
              (
                (await json(join(runs, '.abandoned', held.id, 'run.json'))) ??
                (await json(join(runs, held.id, 'run.json')))
              )?.status === 'abandoned',
            'stop peer-absent fixture',
          );
        } finally {
          await host?.close();
          host = undefined;
          await rename(hidden, native);
          await writeFile(settingsPath, settings);
        }
        continue;
      }
      host = await launch(cwd, session);
      if (mode === 'plan' || mode === 'stop')
        await writeFile(join(sandbox, 'drop-next'), 'drop');
      hold = mode === 'stop' || mode === 'deadline';
      supervisorReply = false;
      releaseSupervisorChild = false;
      supervisorReturned = false;
      supervisorReplyOutcome = undefined;
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
      if (
        [
          'missing-agent',
          'missing-skill',
          'lazy-skill',
          'owned-collision',
          'agent-ceiling',
        ].includes(mode)
      ) {
        const refused = await waitFor(async () => {
          assert.equal(
            calls.some(
              (call) => call.mode === mode && (call.worker || call.reviewer),
            ),
            false,
            'Application admission must refuse before model work',
          );
          const current = await json(join(runs, run.id, 'run.json'));
          return (
            current?.error?.includes('Native launch admission refused') &&
            current
          );
        }, `application admission refusal: ${mode}`);
        assert.match(
          refused.error,
          mode === 'missing-agent'
            ? /missing_agent/
            : mode === 'missing-skill'
              ? /missing_skill/
              : mode === 'agent-ceiling'
                ? /restricted_agent/
                : mode === 'owned-collision'
                  ? /owned_reviewer_collision/
                  : /denied_required_tool/,
        );
        assert.match(refused.error, /Correct.*resume/i);
        assert.equal(refused.activeOperation?.native?.phase, 'prepared');
        assert.equal(refused.activeOperation.externalRunId, undefined);
        assert.notEqual(refused.activeOperation.processTreeExited, true);
        const launches = existsSync(join(sandbox, 'spawns.jsonl'))
          ? (await readFile(join(sandbox, 'spawns.jsonl'), 'utf8'))
              .trim()
              .split('\n')
              .map(JSON.parse)
          : [];
        assert.equal(
          launches.filter((value) => value.pid === host.child.pid).length,
          0,
          'No native spawn emitted on admission refusal',
        );
        console.log(
          JSON.stringify({
            scenario: 'S33 application admission',
            mode,
            error: refused.error,
            phase: refused.activeOperation.native.phase,
            spawns: 0,
            modelCalls: 0,
          }),
        );
        host.send({
          id: 'admission-stop',
          type: 'prompt',
          message: `/exec stop ${run.id} --force`,
        });
        await waitFor(async () => {
          const current =
            (await json(join(runs, run.id, 'run.json'))) ??
            (await json(join(runs, '.abandoned', run.id, 'run.json')));
          return current?.status === 'abandoned';
        }, 'retire undispatched refused fixture');
      } else if (mode === 'deadline') {
        const failed = await waitFor(
          async () => {
            const current = await json(join(runs, run.id, 'run.json'));
            const op = current?.activeOperation ?? current?.failedOperation;
            const status = op?.asyncDir
              ? await json(join(op.asyncDir, 'status.json'))
              : undefined;
            return (
              status &&
              ['failed', 'stopped'].includes(status.state) && {
                current,
                op,
                status,
              }
            );
          },
          `actual native refusal/expiry: ${mode}`,
          45000,
        );
        assert.notEqual(failed.current.status, 'completed');
        assert.ok(
          calls.some(
            (call) => call.mode === mode && call.worker && !call.wrote,
          ),
          'Deadline fired after the real model request started',
        );
        assert.match(
          JSON.stringify(failed.status),
          /timeout|timed.out|deadline/i,
        );
        assert.equal(failed.status.timeoutMs, 8000);
        assert.equal(existsSync(join(cwd, 'result.txt')), false);
        const step = failed.status.steps.find(
          (value) => value.workflowKey === 'main',
        );
        assert.ok(step?.runId);
        const child = await waitFor(
          async () => {
            const status = await json(
              join(dirname(failed.op.asyncDir), step.runId, 'status.json'),
            );
            return (
              status &&
              !['running', 'queued'].includes(status.state) &&
              status.processTerminal &&
              status
            );
          },
          'bounded child expiry and published process evidence',
          20000,
        );
        assert.equal(child.timeoutMs, 8000);
        assert.match(JSON.stringify(child), /timeout|timed.out|deadline/i);
        assert.equal(child.processTerminal.runId, step.runId);
        const proof = await waitFor(
          async () => {
            const value = await json(
              join(
                dirname(failed.op.asyncDir),
                step.runId,
                'process-terminal.json',
              ),
            );
            return (
              value && ['observed', 'unknown'].includes(value.state) && value
            );
          },
          'published deadline retirement disposition',
          10000,
        );
        assert.equal(proof.runId, step.runId);
        assert.equal(
          proof.runnerProcessInstanceId,
          child.processTerminal.runnerProcessInstanceId,
        );
        console.log(
          JSON.stringify({
            scenario: 'S28 child expiry',
            state: child.state,
            error: child.error,
            timeoutMs: child.timeoutMs,
            proof,
          }),
        );
        console.log(
          JSON.stringify({
            scenario: mode,
            state: failed.status.state,
            error: failed.status.error,
            steps: failed.status.steps,
            operationId: failed.op.operationId,
          }),
        );
        host.send({
          id: 'refused-stop',
          type: 'prompt',
          message: `/exec stop ${run.id} --force`,
        });
        await waitFor(async () => {
          const current =
            (await json(join(runs, run.id, 'run.json'))) ??
            (await json(join(runs, '.abandoned', run.id, 'run.json')));
          return current?.status === 'abandoned' && current;
        }, 'end refused/expired fixture');
        retainUnknownOwnership = true; // Keep raw proof/expiry evidence, including unknown retirement.
      } else if (mode === 'supervisor') {
        const request = await waitFor(
          () => json(join(sandbox, 'supervisor-request.json')),
          'real contact_supervisor request',
        );
        const tracked = await waitFor(async () => {
          const current = await json(join(runs, run.id, 'run.json'));
          return current?.activeOperation?.asyncDir && current;
        }, 'supervisor root binding');
        const originalOp = tracked.activeOperation;
        const waiting = await json(join(originalOp.asyncDir, 'status.json'));
        const childId = request.runId;
        const childPath = join(
          dirname(originalOp.asyncDir),
          childId,
          'status.json',
        );
        const originalChild = await waitFor(
          () => json(childPath),
          'supervisor child status',
        );
        assert.ok(originalChild.steps[0].sessionFile);
        const notices = host.output.length;
        host.send({
          id: 'supervisor-detach',
          type: 'prompt',
          message: `/subagents-detach ${childId}`,
        });
        const detachOutcome = await waitFor(
          () =>
            host.output
              .slice(notices)
              .find(
                (value) =>
                  typeof value.message === 'string' &&
                  /detach|foreground/i.test(value.message),
              ),
          'actual detach command outcome',
          15000,
        );
        assert.equal(supervisorReturned, false);
        assert.equal(
          calls.filter((call) => call.mode === mode && call.worker).length,
          1,
          'No contact_supervisor result has reached the waiting child before replacement',
        );
        assert.equal(existsSync(join(cwd, 'result.txt')), false);
        // Replace the actual host while the original question is still unanswered.
        await host.close();
        host = undefined;
        host = await launch(cwd, session);
        supervisorReply = true;
        host.send({
          id: 'supervisor-answer',
          type: 'prompt',
          message: 'Reply to the retained fixture supervisor request now.',
        });
        await waitFor(
          () => supervisorReplyOutcome,
          'public reply outcome after pending-question reload',
        );
        assert.match(supervisorReplyOutcome, /Replied to supervisor request/);
        await waitFor(
          () => supervisorReturned,
          'reply reaches original waiting child',
        );
        const detachment = await json(join(sandbox, 'supervisor-detach.json'));
        releaseSupervisorChild = true;
        const settled = await waitFor(
          async () => {
            const child = await json(childPath);
            return (
              child && !['running', 'queued'].includes(child.state) && child
            );
          },
          'same child settles or reaches its original deadline after reload',
          70000,
        );
        assert.equal(settled.runId, childId);
        assert.equal(
          settled.steps[0].sessionFile,
          originalChild.steps[0].sessionFile,
        );
        const launches = (await readFile(join(sandbox, 'spawns.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse);
        const owned = launches.filter(
          (value) =>
            value.pid === tracked.lease.pid || value.pid === host.child.pid,
        );
        assert.equal(
          owned.length,
          1,
          'Supervisor continuation never launches a replacement worker',
        );
        host.send({
          id: 'pause-supervisor',
          type: 'prompt',
          message: `/exec pause ${run.id}`,
        });
        const paused = await waitFor(async () => {
          const current = await json(join(runs, run.id, 'run.json'));
          return current?.status === 'paused' && current.userStopped && current;
        }, 'explicit pause wins');
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal(
          (await json(join(runs, run.id, 'run.json'))).status,
          'paused',
        );
        assert.equal(
          paused.activeOperation?.operationId ??
            paused.failedOperation?.operationId,
          originalOp.operationId,
        );
        assert.equal(
          (await git(['log', '--format=%s'])).stdout
            .split('\n')
            .filter((line) => line === 'Deliver fixture').length,
          1,
        );
        const retainedOp = paused.activeOperation ?? paused.failedOperation;
        if (retainedOp.native?.phase !== 'retired') {
          assert.notEqual(retainedOp.processTreeExited, true);
          assert.notEqual(paused.tasks?.['1']?.state, 'accepted');
        }
        console.log(
          JSON.stringify({
            scenario: 'S25',
            controllerPhase: retainedOp.native?.phase,
            controllerProof: retainedOp.native?.terminalProof,
            sideEffects: 1,
            replacedWhilePending: true,
            supervisorReplyOutcome,
            request,
            detachment,
            detachOutcome: detachOutcome.message,
            waitingState: waiting?.state,
            childRunId: childId,
            childSession: settled.steps[0].sessionFile,
            childState: settled.state,
            nativeProof: settled.processTerminal,
            paused: true,
          }),
        );
        retainUnknownOwnership = true;
      } else if (['wrong-commit', 'malformed', 'missing'].includes(mode)) {
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
        if (mode === 'valid-skill') {
          assert.ok(
            calls.some(
              (call) =>
                call.mode === mode &&
                call.worker &&
                call.model === 'scoped-fixture',
            ),
          );
          assert.ok(
            calls.some(
              (call) =>
                call.mode === mode && call.reviewer && call.model === 'fixture',
            ),
          );
          console.log(
            JSON.stringify({
              scenario: 'S33 valid selected skill',
              scope: 'scoped',
              workerModel: 'scoped-fixture',
              reviewerModel: 'inherit',
              status: completed.status,
            }),
          );
        }
        if (mode === 'schema-ceiling')
          console.log(
            JSON.stringify({
              scenario: 'S33 schema ceiling',
              internalProtocolTool: 'structured_output',
              effectiveToolSets: calls
                .filter((call) => call.mode === mode && call.reviewer)
                .map((call) => call.tools),
            }),
          );
        if (mode === 'tool-ceiling') {
          assert.equal(readonlyRefusal, true);
          assert.equal(existsSync(join(cwd, 'forbidden-review-write')), false);
          console.log(
            JSON.stringify({
              scenario: 'S34 readonly refusal',
              mutationAttemptRefused: readonlyRefusal,
              effectiveTools: calls.find(
                (call) => call.mode === mode && call.reviewer,
              )?.tools,
              sentinelExists: false,
            }),
          );
        }
        if (mode === 'cutover') {
          assert.equal(await executorFingerprint(), executorHash);
          for (const name of removed) {
            assert.equal(existsSync(join(cwd, 'node_modules', name)), false);
            assert.throws(() =>
              createRequire(join(cwd, 'package.json')).resolve(name),
            );
          }
          assert.equal(completed.archiveOperation?.phase, 'retired');
          assert.ok(
            completed.archiveOperation.destination.includes('completed'),
          );
          assert.ok(
            await readFile(completed.archiveOperation.destination, 'utf8'),
          );
          assert.match(
            (await git(['log', '-1', '--format=%s'])).stdout,
            /archive/,
          );
          console.log(
            JSON.stringify({
              scenario: 'S54',
              executorHash,
              executorTarballHash,
              executor: installed,
              target: cwd,
              state: completed.status,
              archive: completed.archiveOperation.destination,
            }),
          );
        }
        const evidenceDirs = await readdir(join(runs, run.id, 'native'));
        assert.equal(
          evidenceDirs.length,
          mode === 'findings' ? 4 : mode === 'schema-ceiling' ? 1 : 2,
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
        const lost = await waitFor(async () => {
          const current = await json(join(runs, run.id, 'run.json'));
          const dropped = await json(join(sandbox, 'dropped.json'));
          return (
            current?.activeOperation?.native?.request.requestId ===
              dropped?.requestId && dropped
          );
        }, 'actual lost spawn reply before force stop');
        assert.equal(typeof lost.runId, 'string');
        assert.equal(
          (await json(join(runs, run.id, 'run.json'))).activeOperation
            .externalRunId,
          undefined,
          'Force-stop begins before ordinary binding',
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
        const delivered = (await readFile(join(sandbox, 'stops.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse);
        assert.ok(
          delivered.some(
            (stop) => stop.pid === host.child.pid && stop.runId === lost.runId,
          ),
          'Exact alias discovery permits native stop after abandonment',
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
    const loads = (
      existsSync(join(sandbox, 'loads.jsonl'))
        ? await readFile(join(sandbox, 'loads.jsonl'), 'utf8')
        : ''
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    const children = loads.filter((value) => value.child);
    assert.ok(
      children.length >=
        scenarios.reduce(
          (sum, value) =>
            sum +
            ([
              'no-peer',
              'missing-agent',
              'missing-skill',
              'lazy-skill',
              'owned-collision',
              'agent-ceiling',
              'stop',
            ].includes(value)
              ? 0
              : ['schema-ceiling', 'deadline', 'supervisor'].includes(value)
                ? 1
                : value === 'findings'
                  ? 4
                  : 2),
          0,
        ),
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
    if (scenarios.includes('plan') || scenarios.includes('stop'))
      assert.ok(await json(join(sandbox, 'dropped.json')));
    if (
      scenarios.some((value) =>
        ['plan', 'goal', 'findings', 'cutover', 'tool-ceiling'].includes(value),
      )
    )
      assert.ok(
        calls.some((call) => call.worker) &&
          calls.some((call) => call.reviewer),
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
