import * as sharp from 'sharp';
import { ImageManager } from './index';

describe('리사이즈 이미지 매니저', () => {
	it('요청한 너비와 높이로 이미지 버퍼를 리사이징한다', async () => {
		const sourceImage = await sharp({
			create: {
				width: 20,
				height: 10,
				channels: 3,
				background: '#ff0000',
			},
		})
			.png()
			.toBuffer();

		const resizedImage = await new ImageManager().resize(sourceImage, {
			width: 5,
			height: 4,
		});
		const metadata = await sharp(resizedImage).metadata();

		expect(metadata.width).toBe(5);
		expect(metadata.height).toBe(4);
	});

	it('한쪽 크기만 요청하면 누락된 크기는 원본대로 유지한다', async () => {
		const sourceImage = await sharp({
			create: {
				width: 20,
				height: 10,
				channels: 3,
				background: '#00ff00',
			},
		})
			.png()
			.toBuffer();

		const resizedImage = await new ImageManager().resize(sourceImage, {
			width: 10,
		});
		const metadata = await sharp(resizedImage).metadata();

		expect(metadata.width).toBe(10);
		expect(metadata.height).toBe(10);
	});

	it('format을 요청하면 리사이징 결과를 해당 포맷으로 변환한다', async () => {
		const sourceImage = await sharp({
			create: {
				width: 20,
				height: 10,
				channels: 3,
				background: '#0000ff',
			},
		})
			.png()
			.toBuffer();

		const resizedImage = await new ImageManager().resize(sourceImage, {
			width: 10,
			height: 5,
			format: 'webp',
		});
		const metadata = await sharp(resizedImage).metadata();

		expect(metadata.width).toBe(10);
		expect(metadata.height).toBe(5);
		expect(metadata.format).toBe('webp');
	});
});
