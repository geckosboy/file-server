import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IngestionResult, IngestionService } from './ingestion.service';
import { IngestionAuthGuard } from './ingestion-auth.guard';

@Controller('api/ingestion')
@UseGuards(IngestionAuthGuard)
export class IngestionController {
	constructor(private readonly ingestionService: IngestionService) {}

	@Post('events')
	@HttpCode(202)
	ingestEvent(@Body() body: unknown): Promise<IngestionResult> {
		return this.ingestionService.ingest(body);
	}

	@Post('legacy/upload-result')
	@HttpCode(202)
	ingestLegacyUploadResult(@Body() body: unknown): Promise<IngestionResult> {
		return this.ingestionService.ingestLegacyUploadResult(body);
	}
}
