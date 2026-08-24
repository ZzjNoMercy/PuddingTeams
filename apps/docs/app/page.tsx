import Link from "next/link";
import { BrandLabel } from "@/components/brand";

export default function Home() {
  return (
    <main className="docs-entry">
      <BrandLabel />
      <span>OPEN SOURCE DOCUMENTATION</span>
      <h1>PuddingTeams<br />Documents</h1>
      <p>架构、部署、协作模式、Harness、Session Goal 与 Connector Extension。</p>
      <Link href="/docs/">阅读文档 →</Link>
    </main>
  );
}
