import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  RuntimeAppKind,
  RuntimeComponentProfile,
  RuntimeEvidence,
  RuntimeLaunchCommand,
  RuntimeTracePlan,
  RuntimeTracerKind,
} from 'gitnexus-shared';

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const safeJson = async (filePath: string): Promise<JsonObject | null> => {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : null;
  } catch {
    return null;
  }
};

const exists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const evidence = (
  detail: string,
  confidence: number,
  filePath?: string,
  source: RuntimeEvidence['source'] = 'manifest',
): RuntimeEvidence => ({ source, detail, confidence, ...(filePath ? { filePath } : {}) });

const dependencySet = (pkg: JsonObject): Set<string> =>
  new Set([
    ...Object.keys(asObject(pkg.dependencies)),
    ...Object.keys(asObject(pkg.devDependencies)),
    ...Object.keys(asObject(pkg.peerDependencies)),
  ]);

const inferNodeKind = (
  deps: Set<string>,
): { kind: RuntimeAppKind; framework?: string; confidence: number } => {
  if (deps.has('next')) return { kind: 'browser', framework: 'Next.js', confidence: 0.95 };
  if (deps.has('@remix-run/react')) {
    return { kind: 'browser', framework: 'Remix', confidence: 0.94 };
  }
  if (deps.has('react') && (deps.has('vite') || deps.has('@vitejs/plugin-react'))) {
    return { kind: 'browser', framework: 'React + Vite', confidence: 0.94 };
  }
  if (deps.has('react')) return { kind: 'browser', framework: 'React', confidence: 0.86 };
  if (deps.has('vue')) return { kind: 'browser', framework: 'Vue', confidence: 0.9 };
  if (deps.has('svelte') || deps.has('@sveltejs/kit')) {
    return { kind: 'browser', framework: 'Svelte', confidence: 0.9 };
  }
  if (deps.has('express')) return { kind: 'node', framework: 'Express', confidence: 0.94 };
  if (deps.has('fastify')) return { kind: 'node', framework: 'Fastify', confidence: 0.94 };
  if (deps.has('@nestjs/core')) return { kind: 'node', framework: 'NestJS', confidence: 0.94 };
  if (deps.has('hono')) return { kind: 'node', framework: 'Hono', confidence: 0.9 };
  return { kind: 'node', confidence: 0.68 };
};

const packageManagerFor = async (root: string, repoRoot: string): Promise<string> => {
  for (const [file, manager] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    if (
      (await exists(path.join(root, file))) ||
      (root !== repoRoot && (await exists(path.join(repoRoot, file))))
    ) {
      return manager;
    }
  }
  return 'npm';
};

const inferEntrypoints = async (root: string, pkg: JsonObject): Promise<string[]> => {
  const candidates = [
    pkg.source,
    pkg.module,
    pkg.main,
    'src/main.tsx',
    'src/main.ts',
    'src/index.ts',
    'src/server.ts',
    'server.ts',
    'server.js',
    'index.js',
  ].filter((value): value is string => typeof value === 'string');
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) found.push(candidate.replace(/\\/g, '/'));
  }
  return [...new Set(found)].slice(0, 8);
};

const inferNodeLaunch = (
  pkg: JsonObject,
  packageManager: string,
  cwd?: string,
): RuntimeLaunchCommand[] => {
  const scripts = asObject(pkg.scripts);
  const preferred: Array<[string, RuntimeLaunchCommand['role'], number]> = [
    ['dev', 'dev', 0.96],
    ['start', 'start', 0.92],
    ['serve', 'dev', 0.84],
    ['worker', 'worker', 0.88],
    ['test', 'test', 0.8],
  ];
  return preferred.flatMap(([name, role, confidence]) => {
    if (typeof scripts[name] !== 'string') return [];
    return [
      {
        command: `${packageManager} run ${name}`,
        ...(cwd && cwd !== '.' ? { cwd } : {}),
        role,
        confidence,
        evidence: [
          evidence(
            `package.json script ${name}: ${scripts[name]}`,
            confidence,
            path.posix.join(cwd ?? '.', 'package.json').replace(/^\.\//, ''),
            'script',
          ),
        ],
      },
    ];
  });
};

const inferNodeTrace = (kind: RuntimeAppKind, framework?: string): RuntimeTracePlan[] => {
  const plans: RuntimeTracePlan[] = [];
  if (kind === 'browser') {
    plans.push({
      tracer: 'browser-cdp-coverage',
      enabled: true,
      confidence: framework?.includes('Vite') ? 0.96 : 0.86,
      options: { intervalMs: 100 },
      evidence: [
        evidence(
          `${framework ?? 'browser app'} supports browser runtime tracing`,
          0.9,
          undefined,
          'dependency',
        ),
      ],
    });
  }
  plans.push({
    tracer: 'node-v8-coverage',
    enabled: kind !== 'browser' || Boolean(framework?.includes('Next')),
    confidence: 0.9,
    options: { intervalMs: 100 },
    evidence: [evidence('Node package manifest detected', 0.9, undefined, 'dependency')],
  });
  return plans;
};

const componentId = (relativeRoot: string): string =>
  relativeRoot === '.'
    ? 'root-node'
    : `node-${relativeRoot
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`;

export const detectNodeComponent = async (
  root: string,
  repoRoot: string = root,
): Promise<RuntimeComponentProfile | null> => {
  const pkg = await safeJson(path.join(root, 'package.json'));
  if (!pkg) return null;

  const relativeRoot = path.relative(repoRoot, root).replace(/\\/g, '/') || '.';
  const deps = dependencySet(pkg);
  const inferred = inferNodeKind(deps);
  const packageManager = await packageManagerFor(root, repoRoot);
  const manifestPath = path.posix.join(relativeRoot, 'package.json').replace(/^\.\//, '');
  const componentEvidence: RuntimeEvidence[] = [
    evidence('package.json detected', 0.99, manifestPath),
  ];
  if (inferred.framework) {
    componentEvidence.push(
      evidence(
        `${inferred.framework} dependencies detected`,
        inferred.confidence,
        manifestPath,
        'dependency',
      ),
    );
  }

  return {
    id: componentId(relativeRoot),
    name: typeof pkg.name === 'string' ? pkg.name : path.basename(root),
    root: relativeRoot,
    kind: inferred.kind,
    framework: inferred.framework,
    packageManager,
    entrypoints: await inferEntrypoints(root, pkg),
    launch: inferNodeLaunch(pkg, packageManager, relativeRoot),
    trace: inferNodeTrace(inferred.kind, inferred.framework),
    confidence: inferred.confidence,
    evidence: componentEvidence,
  };
};

/** Detect the root package plus direct child packages without traversing dependency trees. */
export const detectNodeComponents = async (
  repoRoot: string,
): Promise<RuntimeComponentProfile[]> => {
  const roots = [repoRoot];
  try {
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
        continue;
      const child = path.join(repoRoot, entry.name);
      if (await exists(path.join(child, 'package.json'))) roots.push(child);
    }
  } catch {
    // The root probe below will provide the deterministic fallback.
  }
  const components = await Promise.all(
    roots.slice(0, 65).map((root) => detectNodeComponent(root, repoRoot)),
  );
  return components.filter((item): item is RuntimeComponentProfile => item !== null);
};

export const detectPythonComponent = async (
  repoRoot: string,
): Promise<RuntimeComponentProfile | null> => {
  const markers = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock'];
  const present: string[] = [];
  for (const marker of markers) if (await exists(path.join(repoRoot, marker))) present.push(marker);
  if (present.length === 0) return null;

  const candidates = ['app.py', 'main.py', 'manage.py', 'src/main.py'];
  const entrypoints: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(repoRoot, candidate))) entrypoints.push(candidate);
  }

  let manifestText = '';
  for (const marker of present.slice(0, 2)) {
    try {
      manifestText += `\n${(await fs.readFile(path.join(repoRoot, marker), 'utf8')).slice(0, 200_000)}`;
    } catch {
      // A disappearing optional marker does not invalidate the other evidence.
    }
  }
  const framework = /fastapi/i.test(manifestText)
    ? 'FastAPI'
    : /django/i.test(manifestText)
      ? 'Django'
      : /flask/i.test(manifestText)
        ? 'Flask'
        : undefined;
  const launch: RuntimeLaunchCommand[] = [];
  if (await exists(path.join(repoRoot, 'manage.py'))) {
    launch.push({
      command: 'python manage.py runserver',
      role: 'dev',
      confidence: 0.9,
      evidence: [evidence('Django manage.py detected', 0.9, 'manage.py')],
    });
  } else if (entrypoints[0]) {
    launch.push({
      command: `python ${entrypoints[0]}`,
      role: 'dev',
      confidence: 0.72,
      evidence: [evidence(`Python entrypoint ${entrypoints[0]} detected`, 0.72, entrypoints[0])],
    });
  }

  return {
    id: 'root-python',
    name: `${path.basename(repoRoot)} Python`,
    root: '.',
    kind: 'python',
    framework,
    entrypoints,
    launch,
    trace: [
      {
        tracer: 'python-profile',
        enabled: true,
        confidence: 0.95,
        options: { intervalMs: 100 },
        evidence: [evidence('Python project markers detected', 0.95, present[0])],
      },
    ],
    confidence: framework ? 0.9 : 0.78,
    evidence: present.map((marker) => evidence(`${marker} detected`, 0.95, marker)),
  };
};

export const detectOtherComponents = async (
  repoRoot: string,
): Promise<RuntimeComponentProfile[]> => {
  const specs: Array<{
    marker: string;
    kind: RuntimeAppKind;
    tracer: RuntimeTracerKind;
    name: string;
  }> = [
    { marker: 'go.mod', kind: 'go', tracer: 'opentelemetry', name: 'Go application' },
    { marker: 'Cargo.toml', kind: 'rust', tracer: 'opentelemetry', name: 'Rust application' },
    { marker: 'pom.xml', kind: 'java', tracer: 'opentelemetry', name: 'Java application' },
    { marker: 'build.gradle', kind: 'java', tracer: 'opentelemetry', name: 'Java application' },
  ];
  const found: RuntimeComponentProfile[] = [];
  for (const spec of specs) {
    if (!(await exists(path.join(repoRoot, spec.marker)))) continue;
    found.push({
      id: `root-${spec.kind}`,
      name: `${path.basename(repoRoot)} ${spec.name}`,
      root: '.',
      kind: spec.kind,
      entrypoints: [],
      launch: [],
      trace: [
        {
          tracer: spec.tracer,
          enabled: false,
          confidence: 0.55,
          evidence: [
            evidence(
              `${spec.marker} detected; runtime adapter still needs implementation`,
              0.75,
              spec.marker,
            ),
          ],
        },
      ],
      confidence: 0.72,
      evidence: [evidence(`${spec.marker} detected`, 0.95, spec.marker)],
    });
  }
  return found;
};
