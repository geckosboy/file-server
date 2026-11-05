import { parseGroups } from './ci-images.mjs';
import { runRuntimeDockerSmoke } from './docker-smoke.mjs';
import { runAdminDockerSmoke } from './admin-docker-smoke.mjs';
import {
	createInfrastructureConfig,
	startInfrastructure,
	migrateDatabase,
	stopInfrastructure,
} from './system-test-utils.mjs';

const groups = parseGroups(process.argv[2]);
const infrastructure = await createInfrastructureConfig('image-groups-smoke');
try {
	await startInfrastructure(infrastructure);
	await migrateDatabase(infrastructure);
	const options = { infrastructure, manageInfrastructure: false };
	if (groups.includes('runtime')) await runRuntimeDockerSmoke(options);
	if (groups.includes('admin')) await runAdminDockerSmoke(options);
} finally {
	await stopInfrastructure(infrastructure);
}
