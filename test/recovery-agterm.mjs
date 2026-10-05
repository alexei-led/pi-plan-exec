// Run in a dedicated agterm session. Only the model HTTP boundary is scripted.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
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
const requested = resolve(process.argv[2]);
const sandbox = join(realpathSync(dirname(requested)), basename(requested));
const bridge = realpathSync(resolve(process.argv[3]));
assert.ok(
  !existsSync(sandbox) &&
    [repo, bridge].every((checkout) => {
      const path = relative(checkout, sandbox);
      return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
    }),
  'Use a new sandbox outside both checkouts.',
);
mkdirSync(sandbox);
for (const dir of ['home', 'agent/agents', 'rejected', 'legacy'])
  mkdirSync(join(sandbox, dir), { recursive: true });
const gitEnv = {
  PATH: process.env.PATH,
  HOME: join(sandbox, 'home'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
for (const kind of ['rejected', 'legacy']) {
  const cwd = join(sandbox, kind);
  const git = (...args) =>
    execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Recovery Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(
    join(cwd, 'plan.md'),
    '### Task 1: Fixture\n- [ ] Deliver fixture\n',
  );
  writeFileSync(join(cwd, '.gitignore'), '.pi/\n.pi-subagents/\n.ralphex/\n');
  git('add', 'plan.md', '.gitignore');
  git('commit', '-m', 'Fixture baseline');
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (data) => (body += data));
  req.on('end', () => {
    const input = JSON.parse(body);
    const worker = body.includes('PLAN_EXEC_FIXTURE_WORKER');
    const hasTool = input.messages.some((message) => message.role === 'tool');
    appendFileSync(
      join(sandbox, 'model-calls.jsonl'),
      `${JSON.stringify({ worker, hasTool })}\n`,
    );
    const command =
      "node -e \"const fs=require('fs');fs.writeFileSync('result.txt','done\\n');fs.writeFileSync('plan.md',fs.readFileSync('plan.md','utf8').replace('[ ]','[x]'))\" && git add result.txt plan.md && git commit -m 'Deliver fixture'";
    const delta =
      worker && !hasTool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'fixture-write',
                type: 'function',
                function: {
                  name: 'bash',
                  arguments: JSON.stringify({ command }),
                },
              },
            ],
          }
        : {
            role: 'assistant',
            content: worker ? 'Fixture committed.' : 'Ready.',
          };
    const chunk = {
      id: 'fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture',
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
              finish_reason: worker && !hasTool ? 'tool_calls' : 'stop',
            },
          ],
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const agent = join(sandbox, 'agent');
writeFileSync(
  join(agent, 'models.json'),
  JSON.stringify({
    providers: {
      recovery: {
        api: 'openai-completions',
        apiKey: 'local-fixture',
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
writeFileSync(
  join(agent, 'settings.json'),
  JSON.stringify({
    defaultProvider: 'recovery',
    defaultModel: 'fixture',
    defaultThinkingLevel: 'off',
    defaultProjectTrust: 'always',
  }),
);
writeFileSync(
  join(agent, 'agents/recovery-worker.md'),
  '---\nname: recovery-worker\ndescription: Isolated deterministic recovery worker\nmodel: recovery/fixture\nthinking: off\ntools: bash\nsystemPromptMode: replace\ninheritProjectContext: false\ninheritSkills: false\n---\nPLAN_EXEC_FIXTURE_WORKER\nComplete the fixture through the bash tool.\n',
);
const sources = [
  join(bridge, 'node_modules/pi-subagents/index.js'),
  join(bridge, 'src/index.ts'),
  join(repo, 'src/index.ts'),
  join(repo, 'test/fixtures/recovery-host.ts'),
];
writeFileSync(
  join(sandbox, 'loaded-sources.json'),
  JSON.stringify(
    sources.map((path) => ({
      path,
      version: path.includes('pi-subagents/index')
        ? JSON.parse(
            readFileSync(
              join(bridge, 'node_modules/pi-subagents/package.json'),
            ),
          ).version
        : path.includes(bridge)
          ? JSON.parse(readFileSync(join(bridge, 'package.json'))).version
          : JSON.parse(readFileSync(join(repo, 'package.json'))).version,
    })),
    null,
    2,
  ),
);
if (process.argv[4] === '--server-only') {
  console.log(
    `Fixture model ready at http://127.0.0.1:${server.address().port}/v1`,
  );
} else {
  const child = spawn(
    process.execPath,
    [
      join(bridge, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      ...sources.flatMap((path) => ['-e', path]),
    ],
    {
      cwd: join(sandbox, 'rejected'),
      stdio: 'inherit',
      env: {
        PATH: process.env.PATH,
        HOME: join(sandbox, 'home'),
        TMPDIR: sandbox,
        TERM: process.env.TERM,
        COLORTERM: process.env.COLORTERM,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: '1',
        PLAN_EXEC_RECOVERY_SANDBOX: sandbox,
        PLAN_EXEC_RECOVERY_BRIDGE: bridge,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  const [code] = await once(child, 'close');
  server.close();
  process.exitCode = code ?? 1;
}
