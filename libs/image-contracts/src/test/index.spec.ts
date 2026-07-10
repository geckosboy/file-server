import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
	DeleteImageDto,
	ImageQueryDto,
	UploadImageDto,
	matchesClientServicePathPattern,
	normalizeClientServicePathPattern,
	normalizeImageStoragePath,
	normalizeSafeFileName,
	normalizeSafeRelativePath,
	resolveInside,
	splitAndNormalizeImageKey,
	toImageStoragePath,
} from '.././index';
import * as path from 'path';

describe('이미지 계약 DTO', () => {
	it('이미지 크기 쿼리 문자열을 숫자로 변환해 검증한다', async () => {
		const dto = plainToInstance(ImageQueryDto, {
			width: '320',
			height: '240',
			format: 'webp',
		});

		await expect(validate(dto)).resolves.toEqual([]);
		expect(dto.width).toBe(320);
		expect(dto.height).toBe(240);
		expect(dto.format).toBe('webp');
	});

	it('이미지 format 쿼리는 지원하는 출력 포맷만 허용한다', async () => {
		const dto = plainToInstance(ImageQueryDto, {
			format: 'gif',
		});

		const errors = await validate(dto);

		expect(errors).toHaveLength(1);
	});

	it('스토리지 업로드 계약에서 외부 이미지 ID와 이전 이미지 이름은 선택 값으로 허용한다', async () => {
		const dto = plainToInstance(UploadImageDto, {
			path: 'products/image',
			externalImageId: '10',
		});

		await expect(validate(dto)).resolves.toEqual([]);
		expect(dto.externalImageId).toBe(10);
		expect(dto.beforeName).toBeUndefined();
	});

	it('스토리지 삭제 계약은 path/name 또는 imageKey를 허용한다', async () => {
		const byPathAndName = plainToInstance(DeleteImageDto, {
			path: 'products/image',
			name: 'sample.png',
		});
		const byImageKey = plainToInstance(DeleteImageDto, {
			imageKey: 'products/image/sample.png',
		});

		await expect(validate(byPathAndName)).resolves.toEqual([]);
		await expect(validate(byImageKey)).resolves.toEqual([]);
	});

	it('상대 경로를 canonical 형태로 만들고 storage 경계를 강제한다', () => {
		expect(normalizeSafeRelativePath('products/main')).toBe('products/main');
		expect(normalizeImageStoragePath('products/main/image')).toBe(
			'products/main/image',
		);
		expect(toImageStoragePath('products/main')).toBe('products/main/image');
		expect(splitAndNormalizeImageKey('products/main/image/sample.png')).toEqual(
			{ path: 'products/main/image', name: 'sample.png' },
		);
	});

	it.each([
		'../secret/image',
		'safe/../image',
		'safe//image',
		'/absolute/image',
		'C:/absolute/image',
		'safe\\image',
		'safe/%2f/image',
		'safe/%252f/image',
		'safe/．.／secret/image',
	])('traversal, encoding, separator 변형을 거부한다: %s', (unsafePath) => {
		expect(() => normalizeSafeRelativePath(unsafePath)).toThrow();
	});

	it('파일명과 저장소 root 밖 경로를 거부한다', () => {
		expect(() => normalizeSafeFileName('..%2Fsecret.png')).toThrow();
		expect(() => normalizeSafeFileName('．．／secret.png')).toThrow();
		const root = path.resolve('/tmp/image-contract-test');
		expect(resolveInside(root, 'tenant/image/file.png')).toBe(
			path.resolve(root, 'tenant/image/file.png'),
		);
		expect(() => resolveInside(root, '../outside')).toThrow();
	});

	it('제한된 segment glob으로 tenant 경로를 판정한다', () => {
		expect(normalizeClientServicePathPattern('catalog/**/image')).toBe(
			'catalog/**/image',
		);
		expect(
			matchesClientServicePathPattern(
				'catalog/products/image',
				'catalog/**/image',
			),
		).toBe(true);
		expect(
			matchesClientServicePathPattern(
				'other/products/image',
				'catalog/**/image',
			),
		).toBe(false);
		expect(matchesClientServicePathPattern('catalog/image', 'catalog/*')).toBe(
			true,
		);
		expect(() => normalizeClientServicePathPattern('catalog/im*ge')).toThrow();
	});
});
