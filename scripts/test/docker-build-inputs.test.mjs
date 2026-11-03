import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const apps = ['storage', 'resize', 'cache', 'telemetry-api'];
const tracked = new Set(
	execFileSync('git', ['ls-files', '-z'], { cwd: root })
		.toString()
		.split('\0')
		.filter(Boolean),
);

const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('Docker build inputs are committed and omit the inactive common-nest workspace', () => {
	assert.match(
		read('pnpm-workspace.yaml'),
		/^\s*-\s*['"]!libs\/common-nest['"]\s*$/m,
	);

	for (const app of apps) {
		const path = `docker/apps/Dockerfile.${app}`;
		const dockerfile = read(path);
		assert.doesNotMatch(
			dockerfile,
			/^COPY\s+libs\/common-nest(?:\/|\s)/m,
			`${path} must not require the excluded common-nest workspace`,
		);

		for (const line of dockerfile.matchAll(/^COPY\s+(?!--from=)(.+)$/gm)) {
			const parts = line[1].trim().split(/\s+/);
			for (const source of parts.slice(0, -1)) {
				const normalized = source.replace(/^\.\//, '').replace(/\/$/, '');
				assert.ok(
					tracked.has(normalized) ||
						[...tracked].some((file) => file.startsWith(`${normalized}/`)),
					`${path} COPY source is not tracked: ${source}`,
				);
			}
		}
	}
});
