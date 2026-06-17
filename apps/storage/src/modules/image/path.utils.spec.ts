import {
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	resolveInside,
} from './path.utils';

describe('path utils', () => {
	it('rejects parent directory traversal', () => {
		expect(() => normalizeSafeRelativePath('../secret/image')).toThrow();
		expect(() => normalizeSafeRelativePath('safe/../image')).toThrow();
	});

	it('rejects encoded separators in file names', () => {
		expect(() => normalizeSafeFileName('..%2Fsecret.png')).toThrow();
	});

	it('keeps resolved paths inside the configured root', () => {
		const root = '/tmp/file-server-test';
		expect(resolveInside(root, 'tenant/image/file.png')).toBe(
			'/tmp/file-server-test/tenant/image/file.png',
		);
	});
});
