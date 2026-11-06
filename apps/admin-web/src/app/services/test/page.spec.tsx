import { renderToStaticMarkup } from 'react-dom/server';
import { ServicesPageContent } from '../page-content';
import { clientServicesFixture } from '@/lib/fixtures';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

const adminPageRoutes = [
	'dashboard',
	'events',
	'images',
	'lifecycle-events',
	'resize-recommendations',
	'services',
];

const allowedPageExports = new Set([
	'default',
	'config',
	'dynamic',
	'dynamicParams',
	'fetchCache',
	'generateMetadata',
	'generateStaticParams',
	'generateViewport',
	'maxDuration',
	'metadata',
	'preferredRegion',
	'revalidate',
	'runtime',
	'unstable_dynamicStaleTime',
	'unstable_instant',
	'viewport',
]);

const renderServices = () =>
	renderToStaticMarkup(
		<ServicesPageContent services={clientServicesFixture} />,
	);

describe('서비스 레지스트리 페이지', () => {
	it('빌드 시 API 환경변수가 없어도 오류 화면을 정적으로 저장하지 않는다', () => {
		const filename = join(process.cwd(), 'src', 'app', 'services', 'page.tsx');
		const source = ts.createSourceFile(
			filename,
			readFileSync(filename, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		const dynamicExport = source.statements
			.filter(ts.isVariableStatement)
			.filter((statement) =>
				statement.modifiers?.some(
					(modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
				),
			)
			.flatMap((statement) => statement.declarationList.declarations)
			.find(
				(declaration) =>
					ts.isIdentifier(declaration.name) &&
					declaration.name.text === 'dynamic',
			);

		expect(dynamicExport?.initializer?.getText(source)).toBe("'force-dynamic'");
	});

	it.each(adminPageRoutes)(
		'%s route는 Next page가 허용한 export만 공개한다',
		(route) => {
			const filename = join(process.cwd(), 'src', 'app', route, 'page.tsx');
			const source = ts.createSourceFile(
				filename,
				readFileSync(filename, 'utf8'),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			const exportedNames = source.statements.flatMap(readExportedNames);

			expect(
				exportedNames.filter((name) => !allowedPageExports.has(name)),
			).toEqual([]);
		},
	);

	it('서비스 등록 폼과 등록된 서비스를 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('서비스 레지스트리');
		expect(html).toContain('서비스 등록');
		expect(html).toContain('Catalog API');
		expect(html).toContain('catalog-api');
	});

	it('API key 발급/폐기 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('API key 발급');
		expect(html).toContain('API keys');
		expect(html).toContain('cat123');
		expect(html).toContain('폐기');
	});

	it('lifecycle subscription 등록/수정 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('lifecycle subscription 등록');
		expect(html).toContain('Lifecycle subscriptions');
		expect(html).toContain('image.upload.completed');
		expect(html).toContain('image.upload.failed');
		expect(html).toContain('image.delete.completed');
		expect(html).toContain('image.delete.failed');
		expect(html).toContain('catalog-image-consumer');
		expect(html).toContain('활성 subscription');
	});

	it('이미지 리사이징 정책 관리 영역을 표시한다', () => {
		const html = renderServices();

		expect(html).toContain('이미지 리사이징 정책');
		expect(html).toContain('ON_DEMAND');
		expect(html).toContain('PRE_GENERATE');
		expect(html).toContain('400x400');
		expect(html).toContain('webp');
		expect(html).toContain('사전 생성 사이즈 추가');
	});

	it('데이터 요청 실패 안내를 표시한다', () => {
		const html = renderToStaticMarkup(
			<ServicesPageContent
				errorMessage="텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다."
				services={clientServicesFixture}
			/>,
		);

		expect(html).toContain(
			'텔레메트리 API를 불러오지 못해 fixture 데이터로 표시합니다.',
		);
	});
});

const readExportedNames = (statement: ts.Statement): string[] => {
	if (ts.isExportAssignment(statement)) {
		return ['default'];
	}
	if (ts.isExportDeclaration(statement)) {
		if (!statement.exportClause) {
			return ['*'];
		}
		if (ts.isNamespaceExport(statement.exportClause)) {
			return [statement.exportClause.name.text];
		}
		return statement.exportClause.elements.map((element) => element.name.text);
	}
	if (
		!ts.canHaveModifiers(statement) ||
		!ts
			.getModifiers(statement)
			?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
	) {
		return [];
	}
	if (
		ts
			.getModifiers(statement)
			?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
	) {
		return ['default'];
	}
	if (
		ts.isFunctionDeclaration(statement) ||
		ts.isClassDeclaration(statement) ||
		ts.isInterfaceDeclaration(statement) ||
		ts.isTypeAliasDeclaration(statement) ||
		ts.isEnumDeclaration(statement)
	) {
		return statement.name ? [statement.name.text] : [];
	}
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.flatMap((declaration) =>
			ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
		);
	}
	return [];
};
