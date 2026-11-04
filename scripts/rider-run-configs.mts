// Writes Rider/JetBrains run configurations to .run (excluded locally via .git/info/exclude, per machine).
// Each service's environment is captured from its scripts/dev-*.sh by sourcing the script with
// `exec` stubbed, so the scripts stay the single source of truth. Re-run after
// deploy/seed/zitadel-configure.sh regenerates the OIDC client.
//
// Usage: node --experimental-strip-types scripts/rider-run-configs.mts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.run');
const SKIP = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function captureEnv(script: string): Record<string, string> {
  const raw = execFileSync('bash', ['-c', 'exec() { env -0; }; . "$0"', `scripts/${script}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const env: Record<string, string> = {};
  for (const entry of raw.split('\0')) {
    const i = entry.indexOf('=');
    if (i < 1) continue;
    const key = entry.slice(0, i);
    const value = entry.slice(i + 1);
    if (!SKIP.has(key) && process.env[key] !== value) env[key] = value;
  }
  return env;
}

const envs = (e: Record<string, string>) =>
  `<envs>${Object.entries(e)
    .map(([k, v]) => `<env name="${k}" value="${esc(v)}" />`)
    .join('')}</envs>`;

function write(name: string, type: string, factory: string, attrs: string, body: string) {
  const xml = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${name}" type="${type}" factoryName="${factory}" folderName="Nix parts"${attrs}>
    ${body}
    <method v="2" />
  </configuration>
</component>
`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${name.replace(/[^\w]+/g, '_')}.run.xml`), xml);
}

const node = (name: string, dir: string, file: string, script: string) =>
  write(
    name,
    'NodeJSConfigurationType',
    'Node.js',
    ` path-to-js-file="${file}" working-dir="$PROJECT_DIR$/${dir}" node-parameters="--experimental-strip-types"`,
    envs(captureEnv(script)),
  );

const sh = (name: string, script: string) =>
  write(
    name,
    'ShConfigurationType',
    'Shell Script',
    '',
    [
      `<option name="SCRIPT_PATH" value="$PROJECT_DIR$/scripts/${script}" />`,
      `<option name="SCRIPT_WORKING_DIRECTORY" value="$PROJECT_DIR$" />`,
      `<option name="INTERPRETER_PATH" value="/bin/bash" />`,
      `<option name="EXECUTE_IN_TERMINAL" value="false" />`,
      `<option name="EXECUTE_SCRIPT_FILE" value="true" />`,
      `<option name="INDEPENDENT_SCRIPT_PATH" value="true" />`,
      `<option name="INDEPENDENT_SCRIPT_WORKING_DIRECTORY" value="true" />`,
      `<option name="INDEPENDENT_INTERPRETER_PATH" value="true" />`,
    ].join('\n    '),
  );

const npm = (name: string, pkg: string, script: string) =>
  write(
    name,
    'js.build_tools.npm',
    'npm',
    '',
    `<package-json value="$PROJECT_DIR$/${pkg}" /><command value="run" /><scripts><script value="${script}" /></scripts><node-interpreter value="project" /><envs />`,
  );

// Core (.NET): native project config so the Rider debugger launches it directly.
write(
  'Core API',
  'DotNetProject',
  '.NET Project',
  '',
  [
    `<option name="PROJECT_PATH" value="$PROJECT_DIR$/backend/src/Nix.Api/Nix.Api.csproj" />`,
    `<option name="PROJECT_KIND" value="DotNetCore" />`,
    `<option name="PROGRAM_PARAMETERS" value="--urls ${esc(captureEnv('dev-api.sh').NIX_API_ORIGIN ?? 'http://localhost:5014')}" />`,
    `<option name="PASS_PARENT_ENVS" value="1" />`,
    `<option name="PROJECT_EXE_PATH_TRACKING" value="true" />`,
    `<option name="PROJECT_WORKING_DIRECTORY_TRACKING" value="true" />`,
    envs(captureEnv('dev-api.sh')),
  ].join('\n    '),
);

node('Node host', 'apps/node-host', 'src/index.ts', 'dev-node.sh');
node('Sites serve', 'apps/sites', 'src/serve/index.ts', 'dev-sites-serve.sh');

npm('Web', 'apps/web/package.json', 'dev');
write(
  'Web in Chrome',
  'JavascriptDebugType',
  'JavaScript Debug',
  ' uri="http://localhost:5173" useFirstLineBreakpoints="true"',
  '',
);
sh('Stack up', 'dev-stack-up.sh');
npm('Prepare packages', 'package.json', 'prepare');

const compound = (name: string, runs: [string, string][]) => {
  const body = runs.map(([type, n]) => `<toRun type="${type}" name="${n}" />`).join('\n    ');
  writeFileSync(
    join(outDir, `${name.replace(/[^\w]+/g, '_')}.run.xml`),
    `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="${name}" type="CompoundRunConfigurationType" folderName="Nix">
    ${body}
    <method v="2" />
  </configuration>
</component>
`,
  );
};
compound('Nix prepare', [
  ['ShConfigurationType', 'Stack up'],
  ['js.build_tools.npm', 'Prepare packages'],
]);
compound('Nix all services', [
  ['DotNetProject', 'Core API'],
  ['NodeJSConfigurationType', 'Node host'],
  ['NodeJSConfigurationType', 'Sites serve'],
  ['js.build_tools.npm', 'Web'],
]);
console.log(`wrote run configurations to ${outDir}`);
