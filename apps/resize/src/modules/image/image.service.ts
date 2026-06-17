import {
	Inject,
	Injectable,
	InternalServerErrorException,
	Logger,
	NotFoundException,
} from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { performance } from 'perf_hooks';

import { ImageEntity } from 'src/entity/image.entity';
import { ImageManager } from './manager';
import { envConfig } from 'src/config';

@Injectable()
export class ImageService {
	private readonly logger = new Logger(ImageService.name);

	constructor(
		private readonly imageManager: ImageManager,
		@Inject('RESIZE_IMAGE_MICROSERVICE')
		private readonly imageClient: ClientKafka,
	) {}

	private getImageUrl({ path, name }: { path: string; name: string }) {
		const encodedPath = encodeURIComponent(path);
		const encodedName = encodeURIComponent(name);
		return `${envConfig.STORAGE_SERVER}/image/${encodedPath}/${encodedName}`;
	}

	/** 메인 서버로부터 이미지 데이터 가져오기. Buffer형태로 리턴 */
	async getImageFromMain({ path, name }: { path: string; name: string }) {
		let result: Response;
		try {
			result = await fetch(this.getImageUrl({ path, name }), {
				method: 'get',
			});
		} catch (error) {
			this.logger.error(error);
			throw new InternalServerErrorException('파일 서버에 연결할 수 없습니다.');
		}

		if (!result.ok) {
			if (result.status === 404) {
				throw new NotFoundException('존재하지 않는 파일입니다.');
			}
			throw new InternalServerErrorException('파일을 불러올 수 없습니다.');
		}

		const image = await result.arrayBuffer();
		/** 데이터가 없을 시 클라이언트에서 잘못 요청하거나 DB에 주소나 이름 값이 잘못된거임 */
		if (!image.byteLength) {
			throw new NotFoundException('존재하지 않는 파일입니다.');
		}

		return Buffer.from(image);
	}

	/** Width, Height으로 리사이징 */
	async resizeImage(imageInfo: ImageEntity) {
		const { path, name, ...size } = imageInfo;

		const format = name.split('.').at(-1);
		const image = await this.getImageFromMain({ path, name });

		try {
			const startTime = performance.now();

			const result = await this.imageManager.resize(image, size);

			const exeTime = performance.now() - startTime;

			/** 추후 분석 서버로 결과 이벤트를 전달할 수도 있음.(Kafka 사용 예정) */
			this.logger.log(
				`${path}/${name} - ${format} ${size.width ?? '-'}/${size.height ?? '-'}px ${image.byteLength}>>${result.byteLength}byte +${Math.round(exeTime)}ms `,
			);

			return result;
		} catch (error) {
			this.logger.error(error);
			throw error;
		}
	}
}
