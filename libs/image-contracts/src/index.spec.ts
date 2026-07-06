import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DeleteImageDto, ImageQueryDto, UploadImageDto } from './index';

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
});
