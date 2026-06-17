import {
	BadRequestException,
	InternalServerErrorException,
} from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { File, generateRandomString } from '@file/global';
import * as fs from 'fs';
import { resolve } from 'path';
import { extension } from 'mime-types';
import { diskStorage } from 'multer';
import { Root } from 'src/enum';
import { normalizeSafeFileName } from '../path.utils';

const storage = diskStorage({
	destination: function (req, file, cb) {
		const path = resolve(Root, 'temp');

		if (!fs.existsSync(path)) {
			fs.mkdirSync(path, { recursive: true });
		}

		cb(null, path);
	},
	filename: async function (req, file, cb) {
		const name = req.body?.name || generateRandomString(32);
		const ext = extension(file.mimetype);
		if (!ext) {
			return cb(
				new InternalServerErrorException('알 수 없는 확장자입니다.', {
					cause: new Error(),
					description: `mimetype is unknown. [MIME-TYPE: ${file.mimetype}]`,
				}),
				'',
			);
		}

		cb(null, `${normalizeSafeFileName(name)}.${ext}`);
	},
});

const allowedMimeTypes = new Set<string>(File.ImageFileMimeList);

const imageMulterOptions: MulterOptions = {
	storage,
	limits: {
		fileSize: File.FileMaximumSize.Image,
		files: 1,
	},
	fileFilter: (req, file, cb) => {
		if (!allowedMimeTypes.has(file.mimetype)) {
			return cb(
				new BadRequestException('허용되지 않는 이미지 형식입니다.'),
				false,
			);
		}

		return cb(null, true);
	},
};

export default imageMulterOptions;
