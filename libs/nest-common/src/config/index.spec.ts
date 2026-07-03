import { resolve } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { createAppPathTools, loadAppEnvIntoProcessEnv } from './index';

describe('네스트 공통 경로 도구', () => {
	it('앱 소스 디렉터리 기준으로 런타임 루트를 계산한다', () => {
		const dirname = resolve('/repo/apps/cache/src/enum');
		const { Root, getFilePath } = createAppPathTools(dirname);

		expect(Root).toBe(resolve('/repo/apps/cache'));
		expect(getFilePath('.env.local')).toBe(
			resolve('/repo/apps/cache/.env.local'),
		);
	});

	it('빌드된 앱 디렉터리 기준으로 빌드 환경 파일 경로를 계산한다', () => {
		const dirname = resolve('/repo/apps/cache/dist/apps/cache/src/enum');
		const { BuildRoot, getFilePath } = createAppPathTools(dirname);

		expect(BuildRoot).toBe(resolve('/repo/apps/cache'));
		expect(getFilePath('.env', true)).toBe(resolve('/repo/apps/cache/.env'));
	});

	it('앱 env 파일을 process.env에 주입하되 기존 환경변수는 덮어쓰지 않는다', () => {
		const originalDatabaseUrl = process.env.DATABASE_URL;
		const originalPepper = process.env.CLIENT_API_KEY_PEPPER;
		const tempRoot = mkdtempSync(resolve(tmpdir(), 'file-env-'));
		const envFilePath = resolve(tempRoot, '.env.local');
		writeFileSync(
			envFilePath,
			[
				'DATABASE_URL=postgresql://from-file',
				'CLIENT_API_KEY_PEPPER=from-file-pepper',
			].join('\n'),
		);

		try {
			process.env.DATABASE_URL = 'postgresql://from-process';
			delete process.env.CLIENT_API_KEY_PEPPER;

			const loaded = loadAppEnvIntoProcessEnv(
				(filename) => resolve(tempRoot, filename),
				{ envFilePath, nodeEnv: 'development' },
			);

			expect(loaded).toEqual({
				DATABASE_URL: 'postgresql://from-file',
				CLIENT_API_KEY_PEPPER: 'from-file-pepper',
			});
			expect(process.env.DATABASE_URL).toBe('postgresql://from-process');
			expect(process.env.CLIENT_API_KEY_PEPPER).toBe('from-file-pepper');
		} finally {
			if (originalDatabaseUrl === undefined) {
				delete process.env.DATABASE_URL;
			} else {
				process.env.DATABASE_URL = originalDatabaseUrl;
			}
			if (originalPepper === undefined) {
				delete process.env.CLIENT_API_KEY_PEPPER;
			} else {
				process.env.CLIENT_API_KEY_PEPPER = originalPepper;
			}
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
