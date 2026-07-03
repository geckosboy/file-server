import {
	createAppPathTools,
	loadAppEnvIntoProcessEnv,
} from '@file/nest-common';

const { getFilePath } = createAppPathTools(__dirname);

export const loadedTelemetryApiEnv = loadAppEnvIntoProcessEnv(getFilePath);
