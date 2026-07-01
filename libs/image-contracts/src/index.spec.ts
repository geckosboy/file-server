import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImageQueryDto, UploadImageDto } from './index';

describe('이미지 계약 DTO', () => {
	it('이미지 크기 쿼리 문자열을 숫자로 변환해 검증한다', async () => {
		const dto = plainToInstance(ImageQueryDto, {
			width: '320',
			height: '240',
		});

		await expect(validate(dto)).resolves.toEqual([]);
		expect(dto.width).toBe(320);
		expect(dto.height).toBe(240);
	});

	it('스토리지 업로드 계약에서 이전 이미지 이름은 선택 값으로 허용한다', async () => {
		const dto = plainToInstance(UploadImageDto, {
			id: '10',
			path: 'products/image',
		});

		await expect(validate(dto)).resolves.toEqual([]);
		expect(dto.id).toBe(10);
		expect(dto.beforeName).toBeUndefined();
	});
});
