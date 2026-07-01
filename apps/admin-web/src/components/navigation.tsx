const links = [
	{ href: '/dashboard', label: 'Dashboard' },
	{ href: '/images', label: 'Images' },
	{ href: '/events', label: 'Events' },
];

export function Navigation() {
	return (
		<nav className="navigation" aria-label="관리자 화면">
			<a className="brand" href="/dashboard">
				파일서버 Admin
			</a>
			<div className="nav-links">
				{links.map((link) => (
					<a key={link.href} href={link.href}>
						{link.label}
					</a>
				))}
			</div>
		</nav>
	);
}
