import { Link, useLocation } from "wouter";
import { LayoutDashboard, List, Activity } from "lucide-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const links = [
    { href: `${basePath}/`, label: "Generator", icon: <LayoutDashboard className="w-4 h-4" /> },
    { href: `${basePath}/jobs`, label: "Jobs History", icon: <List className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background text-foreground font-sans">
      <header className="border-b border-border bg-card">
        <div className="container max-w-6xl mx-auto flex items-center h-14 px-4 gap-6">
          <div className="flex items-center gap-2 font-mono font-bold text-primary">
            <Activity className="w-5 h-5" />
            <span>NSE CHARTS</span>
          </div>
          
          <nav className="flex items-center gap-1 ml-4">
            {links.map((link) => {
              const isActive = location === link.href || (location === "" && link.href === basePath + "/");
              return (
                <Link key={link.href} href={link.href} className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors ${isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                  {link.icon}
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="flex-1 container max-w-6xl mx-auto p-4 py-8">
        {children}
      </main>
    </div>
  );
}
