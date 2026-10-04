import { Outlet } from "react-router-dom";
import { Footer } from "./Footer";
import { Header } from "./Header";

export function Layout() {
  return (
    <div className="min-h-screen bg-surface font-body-md text-on-surface">
      <Header />
      <main className="w-full pt-20 bg-surface min-h-[calc(100vh-20rem)]">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
