import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
	extends PrismaClient
	implements OnModuleInit, OnModuleDestroy
{
	constructor() {
		const adapter = new PrismaPg({
			connectionString: readDatabaseUrl(),
		});
		super({ adapter });
	}

	async onModuleInit() {
		await this.$connect();
	}

	async onModuleDestroy() {
		await this.$disconnect();
	}
}

function readDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (databaseUrl) {
		return databaseUrl;
	}
	throw new Error('DATABASE_URL 환경변수가 필요합니다.');
}
