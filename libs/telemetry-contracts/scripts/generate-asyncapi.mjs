import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const { createImageTelemetryAsyncApiDocument } = require('../dist/events.js');
const outputPath = resolve(
	scriptDirectory,
	'../../../docs/asyncapi/file-image-telemetry.asyncapi.json',
);
const generated = `${JSON.stringify(createImageTelemetryAsyncApiDocument(), null, 2)}\n`;

if (process.argv.includes('--check')) {
	const current = await readFile(outputPath, 'utf8').catch(() => '');
	if (current !== generated) {
		throw new Error(
			'AsyncAPI drift detected. Run pnpm --filter @file/telemetry-contracts generate:asyncapi.',
		);
	}
	console.log(`AsyncAPI is current: ${outputPath}`);
} else {
	await writeFile(outputPath, generated);
	console.log(`Generated AsyncAPI: ${outputPath}`);
}
