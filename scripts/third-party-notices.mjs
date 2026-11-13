#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.txt: the licence and notice texts of the third-party code and assets Nix
// ships. npm: production dependencies of every workspace package. NuGet: the runtime closure of Core and
// the migrator. Plus what the build bundles by hand (fonts, the embedding model, the Codex binary).
// Needs `pnpm install` and a `dotnet restore` of backend/src first. Run after dependency changes and
// before each release; `--check` exits 1 when the committed file is out of date.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'THIRD-PARTY-NOTICES.txt');
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const licenceFile = /^(licen[cs]e|copying|notice|third-?party-?notices)(\.(md|txt|markdown))?$/i;
// Prebuilt binaries for one OS/CPU: which ones install depends on the machine, and each repeats its parent's licence.
const platformPackage = /-(darwin|linux|win32|android|freebsd)-(x64|arm64|ia32|arm|universal)\b/;
const standardTexts = new Map(); // SPDX id -> canonical text, for packages that ship no licence file

function texts(directory) {
  return readdirSync(directory)
    .filter((name) => licenceFile.test(name) && statSync(join(directory, name)).isFile())
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8').replace(/\r\n/g, '\n').trim());
}

function standard(spdx) {
  const path = join(root, 'scripts', 'licenses', `${spdx}.txt`);
  if (!existsSync(path)) {
    throw new Error(
      `no licence file and no standard text for ${spdx}: add scripts/licenses/${spdx}.txt`,
    );
  }
  standardTexts.set(spdx, readFileSync(path, 'utf8').trim());
  return `Licensed under ${spdx}; the licence text is under "Standard licence texts" at the end.`;
}

function npmPackages() {
  const byLicence = JSON.parse(run('pnpm', ['-r', 'licenses', 'list', '--prod', '--json']));
  return Object.values(byLicence)
    .flat()
    .filter((pkg) => !platformPackage.test(pkg.name))
    .map((pkg) => {
      const found = [...new Set(pkg.paths.flatMap(texts))];
      const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
      return {
        name: pkg.name,
        version: pkg.versions.join(', '),
        licence: pkg.license,
        source: 'npm',
        texts:
          found.length > 0
            ? found
            : [[author && `Copyright ${author}`, standard(pkg.license)].filter(Boolean).join('\n')],
      };
    });
}

function nugetPackages() {
  const store = process.env.NUGET_PACKAGES ?? join(homedir(), '.nuget', 'packages');
  const versions = new Map();
  for (const project of [
    'backend/src/Nix.Api/Nix.Api.csproj',
    'backend/src/Nix.Migrator/Nix.Migrator.csproj',
  ]) {
    const listing = JSON.parse(
      run('dotnet', ['list', project, 'package', '--include-transitive', '--format', 'json']),
    );
    for (const framework of listing.projects.flatMap((p) => p.frameworks ?? [])) {
      for (const pkg of [
        ...(framework.topLevelPackages ?? []),
        ...(framework.transitivePackages ?? []),
      ]) {
        versions.set(pkg.id, pkg.resolvedVersion);
      }
    }
  }
  return [...versions].map(([id, version]) => {
    const directory = join(store, id.toLowerCase(), version);
    const nuspec = readFileSync(join(directory, `${id.toLowerCase()}.nuspec`), 'utf8');
    const field = (name) =>
      nuspec.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1]?.trim();
    const licence = field('license') ?? 'SEE LICENCE TEXT';
    const found = texts(directory);
    const copyright = field('copyright') ?? (field('authors') && `Copyright ${field('authors')}`);
    return {
      name: id,
      version,
      licence,
      source: 'NuGet',
      texts: found.length > 0 ? found : [[copyright, standard(licence)].filter(Boolean).join('\n')],
    };
  });
}

function bundled() {
  const file = (path) => readFileSync(join(root, path), 'utf8').trim();
  return [
    {
      name: 'Go fonts',
      version: 'embedded in Nix.Workers',
      licence: 'BSD-3-Clause',
      source: 'bundled',
      texts: [file('backend/src/Nix.Workers/Fonts/LICENSE')],
    },
    {
      name: 'Noto Sans SC and Noto Sans KR',
      version: 'scripts/fetch-pdf-fonts.sh',
      licence: 'OFL-1.1',
      source: 'bundled',
      texts: [file('backend/fonts/OFL.txt')],
    },
    {
      name: 'bge-small-en-v1.5 (BAAI), int8 ONNX export by Xenova',
      version: 'scripts/fetch-embedding-model.sh',
      licence: 'MIT',
      source: 'bundled',
      texts: [
        `Copyright (c) Beijing Academy of Artificial Intelligence (BAAI)\nhttps://huggingface.co/BAAI/bge-small-en-v1.5\n${standard('MIT')}`,
      ],
    },
    {
      name: 'OpenAI Codex CLI native binary',
      version: 'deploy/docker/node.Dockerfile CODEX_VERSION',
      licence: 'Apache-2.0',
      source: 'bundled',
      texts: [
        'OpenAI Codex\nCopyright 2025 OpenAI\n\nThis project includes code derived from Ratatui (https://github.com/ratatui/ratatui), licensed under the MIT license.\nCopyright (c) 2016-2022 Florian Dehau\nCopyright (c) 2023-2025 The Ratatui Developers\n\nhttps://github.com/openai/codex\n' +
          standard('Apache-2.0'),
      ],
    },
  ];
}

function render(entries) {
  const rule = '='.repeat(78);
  const seen = new Map();
  const blocks = entries.map((entry) => {
    const body = entry.texts
      .map((text) => {
        if (seen.has(text)) {
          return `Same licence text as ${seen.get(text)}.`;
        }
        seen.set(text, `${entry.name} ${entry.version}`);
        return text;
      })
      .join('\n\n');
    return `${rule}\n${entry.name} ${entry.version} (${entry.source}, ${entry.licence})\n${rule}\n\n${body}\n`;
  });
  const appendix = [...standardTexts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([spdx, text]) => `${rule}\nStandard licence text: ${spdx}\n${rule}\n\n${text}\n`);
  return [
    "Third-party notices for Nix\n\nNix includes the third-party software and assets below, under the licences given. This file is generated by scripts/third-party-notices.mjs; do not edit it by hand. Container base images, Electron's own Chromium notices (LICENSES.chromium.html in the desktop app) and services Nix talks to over the network (PostgreSQL, the identity provider, object storage) carry their own notices.\n",
    ...blocks,
    'Standard licence texts\n\nPackages above that ship no licence file of their own are under these texts, with the copyright line given above.\n',
    ...appendix,
  ].join('\n');
}

const entries = [...bundled(), ...nugetPackages(), ...npmPackages()].sort(
  (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
);
const output = render(entries);
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== output) {
    console.error(
      'THIRD-PARTY-NOTICES.txt is out of date: run node scripts/third-party-notices.mjs',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
  console.log(`wrote ${entries.length} entries to THIRD-PARTY-NOTICES.txt`);
}
