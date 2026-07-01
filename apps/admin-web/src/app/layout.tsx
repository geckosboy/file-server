import { Navigation } from '@/components/navigation';
import './globals.css';

export const metadata = {
	title: '파일서버 관리자 대시보드',
	description: '이미지 telemetry 이벤트와 캐시/리사이즈 상태를 확인합니다.',
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="ko">
			<body>
				<Navigation />
				{children}
			</body>
		</html>
	);
}
