import { resolve } from 'path';
import { createAppPathTools } from './index';

describe('Nest 공통 경로 도구', () => {
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
});
