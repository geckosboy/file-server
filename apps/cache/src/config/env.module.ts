import { createEnvConfig } from '@file/nest-common';
import { getFilePath } from 'src/enum';
import { AppConfig } from './env.schema';

export const { ConfigModule, envConfig } = createEnvConfig(
	AppConfig,
	getFilePath,
);
