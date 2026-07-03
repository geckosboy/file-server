import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const DEFAULT_DATABASE_URL =
	'postgresql://file_server:file_server@127.0.0.1:5432/file_server';

@Injectable()
export class PrismaService
	extends PrismaClient
	implements OnModuleInit, OnModuleDestroy
{
	constructor() {
		const adapter = new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
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
