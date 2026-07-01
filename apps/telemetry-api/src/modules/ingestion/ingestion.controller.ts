import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { IngestionResult, IngestionService } from './ingestion.service';

@Controller('api/ingestion')
export class IngestionController {
	constructor(private readonly ingestionService: IngestionService) {}

	@Post('events')
	@HttpCode(202)
	ingestEvent(@Body() body: unknown): IngestionResult {
		return this.ingestionService.ingest(body);
	}

	@Post('legacy/upload-result')
	@HttpCode(202)
	ingestLegacyUploadResult(@Body() body: unknown): IngestionResult {
		return this.ingestionService.ingestLegacyUploadResult(body);
	}
}
