import {
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	resolveInside,
} from '.././path.utils';

describe('경로 유틸', () => {
	it('상위 디렉터리 이동 경로를 거부한다', () => {
		expect(() => normalizeSafeRelativePath('../secret/image')).toThrow();
		expect(() => normalizeSafeRelativePath('safe/../image')).toThrow();
	});

	it('파일명에 인코딩된 경로 구분자가 있으면 거부한다', () => {
		expect(() => normalizeSafeFileName('..%2Fsecret.png')).toThrow();
	});

	it('해석된 경로가 설정된 루트 내부에 머무르게 한다', () => {
		const root = '/tmp/file-server-test';
		expect(resolveInside(root, 'tenant/image/file.png')).toBe(
			'/tmp/file-server-test/tenant/image/file.png',
		);
	});
});
